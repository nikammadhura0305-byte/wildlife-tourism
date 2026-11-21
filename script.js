// ==========================================
// NATIONAL PARK & WILDLIFE TOURISM DASHBOARD
// ==========================================

const DATA_FILES = {
    annual: "assets/dataset/01_indian_tourism_annual_sample.csv",
    wildlife: "assets/dataset/02_iwildcam_2018_demo_annotations.csv",
    monthly: "assets/dataset/03_india_tourism_2025_monthly_sample.csv"
};

const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
];

const datasets = {};
const charts = {};
let wildlifeMap;
let parkMarkers = [];
let currentRoute = "dashboard";
let mapTilesFailed = false;

function normalizeHeader(value) {
    return String(value || "")
        .replace(/^\uFEFF/, "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function parseCSV(text) {
    const rows = [];
    let row = [];
    let value = "";
    let insideQuotes = false;
    const source = String(text).replace(/^\uFEFF/, "");

    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];

        if (insideQuotes && character === '"' && next === '"') {
            value += '"';
            index += 1;
        } else if (character === '"') {
            insideQuotes = !insideQuotes;
        } else if (character === "," && !insideQuotes) {
            row.push(value.trim());
            value = "";
        } else if ((character === "\n" || character === "\r") && !insideQuotes) {
            if (character === "\r" && next === "\n") index += 1;
            row.push(value.trim());
            if (row.some(cell => cell !== "")) rows.push(row);
            row = [];
            value = "";
        } else {
            value += character;
        }
    }

    if (insideQuotes) throw new Error("CSV contains an unclosed quoted field.");
    row.push(value.trim());
    if (row.some(cell => cell !== "")) rows.push(row);
    if (rows.length < 2) return [];

    const headers = rows[0].map(header => header.replace(/^\uFEFF/, "").trim());
    if (headers.some(header => !header)) throw new Error("CSV contains a blank column name.");

    return rows.slice(1).map((values, rowIndex) => {
        if (values.length > headers.length) {
            throw new Error(`CSV row ${rowIndex + 2} has more values than its header.`);
        }
        const record = {};
        headers.forEach((header, index) => {
            record[header] = values[index] === undefined ? "" : values[index].trim();
        });
        return record;
    });
}

function findColumn(rows, aliases) {
    if (!rows.length) return null;
    const columns = new Map(Object.keys(rows[0]).map(key => [normalizeHeader(key), key]));
    for (const alias of aliases) {
        const found = columns.get(normalizeHeader(alias));
        if (found) return found;
    }
    return null;
}

function getNumber(value) {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    const number = Number(String(value).replace(/[₹,\s]/g, "").replace(/%$/, ""));
    return Number.isFinite(number) ? number : null;
}

function sum(rows, column) {
    if (!column || !rows.length) return null;
    let result = 0;
    let validCount = 0;
    rows.forEach(row => {
        const number = getNumber(row[column]);
        if (number !== null) {
            result += number;
            validCount += 1;
        }
    });
    return validCount ? result : null;
}

function formatNumber(value) {
    return value === null || !Number.isFinite(value)
        ? "—"
        : value.toLocaleString("en-IN");
}

function updateKPI(id, value, prefix = "") {
    const element = document.getElementById(id);
    if (element) element.textContent = value === null ? "—" : prefix + formatNumber(value);
}

function setStatus(message, isError = false) {
    const status = document.getElementById("status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("status-error", isError);
}

function monthForRow(row, monthColumn, dateColumn, monthNumberColumn) {
    const dateText = dateColumn ? row[dateColumn] : "";
    if (dateText) {
        const parsedDate = new Date(`${dateText}T00:00:00`);
        if (!Number.isNaN(parsedDate.getTime())) return MONTHS[parsedDate.getMonth()];
    }
    const monthText = monthColumn ? String(row[monthColumn] || "").trim() : "";
    const namedMonth = MONTHS.find(month => month.toLowerCase() === monthText.toLowerCase());
    if (namedMonth) return namedMonth;
    const monthNumber = monthNumberColumn ? Number(row[monthNumberColumn]) : NaN;
    return Number.isInteger(monthNumber) && monthNumber >= 1 && monthNumber <= 12
        ? MONTHS[monthNumber - 1]
        : null;
}

async function loadCSV(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path} could not be loaded (HTTP ${response.status}).`);
    const rows = parseCSV(await response.text());
    if (!rows.length) throw new Error(`${path} has no data rows.`);
    return rows;
}

function populateMonthFilter(rows) {
    const select = document.getElementById("monthFilter");
    if (!select) return;
    const monthColumn = findColumn(rows, ["Month", "Month_Name"]);
    const dateColumn = findColumn(rows, ["Date"]);
    const monthNumberColumn = findColumn(rows, ["Month_Number", "Month Number"]);
    const available = new Set(rows.map(row =>
        monthForRow(row, monthColumn, dateColumn, monthNumberColumn)
    ).filter(Boolean));
    MONTHS.filter(month => available.has(month)).forEach(month => {
        const option = document.createElement("option");
        option.value = month;
        option.textContent = month;
        select.appendChild(option);
    });
}

function getSelectedMonthlyRows() {
    const rows = datasets.monthly || [];
    const selectedMonth = document.getElementById("monthFilter").value;
    if (selectedMonth === "all") return rows;
    const monthColumn = findColumn(rows, ["Month", "Month_Name"]);
    const dateColumn = findColumn(rows, ["Date"]);
    const monthNumberColumn = findColumn(rows, ["Month_Number", "Month Number"]);
    return rows.filter(row =>
        monthForRow(row, monthColumn, dateColumn, monthNumberColumn) === selectedMonth
    );
}

function aggregateBy(rows, keyColumn, valueColumn) {
    const result = new Map();
    if (!keyColumn || !valueColumn) return [];
    rows.forEach(row => {
        const key = String(row[keyColumn] || "").trim();
        const value = getNumber(row[valueColumn]);
        if (!key || value === null) return;
        result.set(key, (result.get(key) || 0) + value);
    });
    return [...result.entries()].map(([label, value]) => ({ label, value }));
}

function aggregateMonthly(rows, valueColumn) {
    const monthColumn = findColumn(rows, ["Month", "Month_Name"]);
    const dateColumn = findColumn(rows, ["Date"]);
    const monthNumberColumn = findColumn(rows, ["Month_Number", "Month Number"]);
    const totals = new Map();
    rows.forEach(row => {
        const month = monthForRow(row, monthColumn, dateColumn, monthNumberColumn);
        const value = valueColumn ? getNumber(row[valueColumn]) : null;
        if (!month || value === null) return;
        totals.set(month, (totals.get(month) || 0) + value);
    });
    return MONTHS.filter(month => totals.has(month)).map(month => ({
        label: month,
        value: totals.get(month)
    }));
}

function destroyChart(name) {
    if (charts[name]) {
        charts[name].destroy();
        delete charts[name];
    }
}

function showNoData(canvasId, message = "No matching values in the loaded dataset.") {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const parent = canvas.parentElement;
    const oldMessage = parent.querySelector(".no-data-message");
    if (oldMessage) oldMessage.remove();
    const text = document.createElement("p");
    text.className = "no-data-message";
    text.textContent = message;
    parent.appendChild(text);
}

function createChart(canvasId, type, labels, values, label) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const parent = canvas.parentElement;
    const oldMessage = parent.querySelector(".no-data-message");
    if (oldMessage) oldMessage.remove();
    destroyChart(canvasId);

    if (!window.Chart) {
        showNoData(canvasId, "Chart.js could not load. Check your internet connection and reload.");
        return;
    }
    if (!values.some(value => value !== null && Number.isFinite(value))) {
        showNoData(canvasId);
        return;
    }

    charts[canvasId] = new Chart(canvas, {
        type,
        data: {
            labels,
            datasets: [{
                label,
                data: values,
                backgroundColor: ["#4caf50", "#81c784", "#a5d6a7", "#2e7d32", "#c5e1a5"],
                borderColor: "#4caf50",
                borderWidth: 2,
                tension: 0.35,
                fill: type === "line"
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: type === "doughnut" }
            },
            scales: type === "doughnut" ? {} : {
                y: { beginAtZero: true }
            }
        }
    });
}

function updateParkList(rows) {
    const container = document.getElementById("parkList");
    if (!container) return;
    container.replaceChildren();

    const parkColumn = findColumn(rows, ["Popular_Destination", "Park", "Park_Name"]);
    const stateColumn = findColumn(rows, ["State", "State_UT", "State/UT"]);
    const visitorColumn = findColumn(rows, ["Total Tourists", "Total_Tourists", "Visitors"]);
    const totals = new Map();

    if (parkColumn && visitorColumn) {
        rows.forEach(row => {
            const name = String(row[parkColumn] || "").trim();
            const state = stateColumn ? String(row[stateColumn] || "").trim() : "";
            const visitors = getNumber(row[visitorColumn]);
            if (!name || visitors === null) return;
            const current = totals.get(name) || { visitors: 0, state };
            current.visitors += visitors;
            totals.set(name, current);
        });
    }

    const leaders = [...totals.entries()]
        .sort((a, b) => b[1].visitors - a[1].visitors)
        .slice(0, 8);

    if (!leaders.length) {
        const hint = document.createElement("p");
        hint.className = "hint";
        hint.textContent = "State and visitor data are not available in the loaded tourism CSV.";
        container.appendChild(hint);
        return;
    }

    const maximum = leaders[0][1].visitors;
    leaders.forEach(([name, info]) => {
        const item = document.createElement("div");
        item.className = "park-row";
        const parkName = document.createElement("span");
        parkName.className = "park-name";
        parkName.title = info.state ? `${name}, ${info.state}` : name;
        parkName.textContent = info.state ? `${name} · ${info.state}` : name;
        const bar = document.createElement("span");
        bar.className = "bar";
        const fill = document.createElement("i");
        fill.style.width = `${Math.max(2, (info.visitors / maximum) * 100)}%`;
        bar.appendChild(fill);
        const count = document.createElement("b");
        count.textContent = formatNumber(info.visitors);
        item.append(parkName, bar, count);
        container.appendChild(item);
    });
}

function updateDashboard() {
    const monthly = getSelectedMonthlyRows();
    const monthlyRows = datasets.monthly || [];
    const visitorColumn = findColumn(monthly, ["Total Tourists", "Total_Tourists", "Total Visitors"]);
    const revenueColumn = findColumn(monthly, ["Tourism Revenue (INR Crore)", "Tourism_Revenue_INR_Crore"]);
    const annual = datasets.annual || [];
    const bookingColumn = findColumn(annual, ["Estimated_Bookings", "Bookings", "Booking_Count"]);

    updateKPI("visitorsKpi", sum(monthly, visitorColumn));
    updateKPI("bookingsKpi", sum(annual, bookingColumn));
    updateKPI("revenueKpi", sum(monthly, revenueColumn), "₹");

    const wildlife = datasets.wildlife || [];
    const presentColumn = findColumn(wildlife, ["animal_present", "Animal Present"]);
    const speciesColumn = findColumn(wildlife, ["species_label", "Species"]);
    const positiveSightings = wildlife.filter(row =>
        ["1", "true", "yes"].includes(String(row[presentColumn] || "").trim().toLowerCase()) &&
        row[speciesColumn] &&
        row[speciesColumn].trim().toLowerCase() !== "none"
    );
    updateKPI("sightingsKpi", positiveSightings.length);

    const visitorTrend = aggregateMonthly(monthlyRows, findColumn(monthlyRows, ["Total Tourists", "Total_Tourists"]));
    createChart(
        "visitorsChart",
        "line",
        visitorTrend.map(item => item.label),
        visitorTrend.map(item => item.value),
        "Visitors"
    );

    const bookingsByState = aggregateBy(
        annual,
        findColumn(annual, ["State_UT", "State"]),
        bookingColumn
    ).sort((a, b) => b.value - a.value);
    createChart(
        "bookingsChart",
        "bar",
        bookingsByState.map(item => item.label),
        bookingsByState.map(item => item.value),
        "Estimated tourism bookings"
    );

    const speciesCounts = aggregateBy(positiveSightings, speciesColumn, presentColumn)
        .sort((a, b) => b.value - a.value);
    createChart(
        "sightingsChart",
        "doughnut",
        speciesCounts.map(item => item.label),
        speciesCounts.map(item => item.value),
        "Demo animal detections"
    );

    const revenueTrend = aggregateMonthly(monthlyRows, findColumn(monthlyRows, ["Tourism Revenue (INR Crore)", "Tourism_Revenue_INR_Crore"]));
    createChart(
        "revenueChart",
        "line",
        revenueTrend.map(item => item.label),
        revenueTrend.map(item => item.value),
        "Tourism revenue (INR crore)"
    );

    updateParkList(monthly);
}

const PARKS = [
    { id: "corbett", name: "Jim Corbett National Park", state: "Uttarakhand", type: "National Park", lat: 29.53, lng: 78.77, species: "Bengal tiger, Asian elephant, gharial", description: "Terai sal forest, river habitats and foothill landscapes.", image: "tiger.jpg" },
    { id: "kaziranga", name: "Kaziranga National Park", state: "Assam", type: "National Park", lat: 26.58, lng: 93.17, species: "One-horned rhinoceros, tiger, wild water buffalo", description: "Brahmaputra floodplain grasslands and wetlands.", image: "elephant.jpg" },
    { id: "ranthambore", name: "Ranthambore National Park", state: "Rajasthan", type: "National Park", lat: 26.02, lng: 76.50, species: "Bengal tiger, leopard, sloth bear", description: "Dry deciduous forest, lakes and historic ruins.", image: "tiger.jpg" },
    { id: "gir", name: "Gir National Park", state: "Gujarat", type: "National Park", lat: 21.12, lng: 70.79, species: "Asiatic lion, leopard, chital", description: "Dry forest and scrubland in the Asiatic lion's natural range.", image: "leopard.jpg" },
    { id: "kanha", name: "Kanha National Park", state: "Madhya Pradesh", type: "National Park", lat: 22.33, lng: 80.61, species: "Barasingha, tiger, gaur", description: "Central Indian sal forest and meadow landscape.", image: "deer.jpg" },
    { id: "bandhavgarh", name: "Bandhavgarh National Park", state: "Madhya Pradesh", type: "National Park", lat: 23.69, lng: 81.03, species: "Bengal tiger, leopard, dhole", description: "Forest ridges, valleys and the Bandhavgarh fort landscape.", image: "tiger.jpg" },
    { id: "tadoba", name: "Tadoba-Andhari Tiger Reserve", state: "Maharashtra", type: "Tiger Reserve", lat: 20.25, lng: 79.37, species: "Bengal tiger, sloth bear, dhole", description: "Dry deciduous forest, bamboo and lake habitats.", image: "tiger.jpg" },
    { id: "pench", name: "Pench National Park", state: "Madhya Pradesh", type: "National Park", lat: 21.65, lng: 79.20, species: "Tiger, leopard, Indian wild dog", description: "Teak woodland and the Pench River landscape.", image: "leopard.jpg" },
    { id: "periyar", name: "Periyar Tiger Reserve", state: "Kerala", type: "Tiger Reserve", lat: 9.46, lng: 77.24, species: "Asian elephant, tiger, gaur", description: "Evergreen Western Ghats forest around Periyar Lake.", image: "elephant.jpg" },
    { id: "bandipur", name: "Bandipur National Park", state: "Karnataka", type: "National Park", lat: 11.67, lng: 76.63, species: "Asian elephant, tiger, gaur", description: "A forest corridor in the Nilgiri Biosphere Reserve.", image: "elephant.jpg" },
    { id: "sundarbans", name: "Sundarbans National Park", state: "West Bengal", type: "National Park", lat: 21.95, lng: 88.90, species: "Bengal tiger, estuarine crocodile, fishing cat", description: "Tidal creeks and mangrove islands in the delta.", image: "tiger.jpg" },
    { id: "manas", name: "Manas National Park", state: "Assam", type: "National Park", lat: 26.72, lng: 91.00, species: "Golden langur, pygmy hog, tiger", description: "Riverine forest and Himalayan foothill grassland.", image: "deer.jpg" },
    { id: "dudhwa", name: "Dudhwa National Park", state: "Uttar Pradesh", type: "National Park", lat: 28.50, lng: 80.64, species: "Swamp deer, Bengal tiger, rhinoceros", description: "Terai grasslands and sal forest on the Indo-Nepal border.", image: "deer.jpg" },
    { id: "nagarhole", name: "Nagarhole National Park", state: "Karnataka", type: "National Park", lat: 12.00, lng: 76.10, species: "Asian elephant, tiger, leopard", description: "Moist deciduous forest and streams in the Nilgiri Biosphere Reserve.", image: "leopard.jpg" }
];

function renderPageChart(canvasId, type, labels, values, label, options = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    destroyChart(canvasId);
    const oldMessage = canvas.parentElement.querySelector(".no-data-message");
    if (oldMessage) oldMessage.remove();

    if (!window.Chart) {
        showNoData(canvasId, "Chart.js could not load. Check your internet connection and reload.");
        return;
    }
    if (!labels.length || !values.some(value => value !== null && Number.isFinite(value))) {
        showNoData(canvasId);
        return;
    }

    const palette = ["#4caf50", "#81c784", "#a5d6a7", "#2e7d32", "#c5e1a5", "#f39a35", "#2196d2"];
    charts[canvasId] = new Chart(canvas, {
        type,
        data: {
            labels,
            datasets: [{
                label,
                data: values,
                backgroundColor: type === "doughnut" ? palette : (options.fill ? "rgba(76, 175, 80, 0.18)" : "#4caf50"),
                borderColor: type === "doughnut" ? "#ffffff" : "#4caf50",
                borderWidth: type === "doughnut" ? 2 : 2,
                tension: 0.35,
                fill: Boolean(options.fill),
                pointRadius: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: options.horizontal ? "y" : "x",
            plugins: {
                legend: { display: type === "doughnut", position: "bottom" }
            },
            scales: type === "doughnut" ? {} : options.horizontal ? {
                x: { beginAtZero: true },
                y: { grid: { display: false } }
            } : {
                y: { beginAtZero: true }
            }
        }
    });
}

function appendTableMessage(tbody, message, columns) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = columns;
    cell.className = "page-empty";
    cell.textContent = message;
    row.appendChild(cell);
    tbody.replaceChildren(row);
}

function appendTableRow(tbody, values) {
    const row = document.createElement("tr");
    values.forEach(value => {
        const cell = document.createElement("td");
        cell.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
        row.appendChild(cell);
    });
    tbody.appendChild(row);
}

function uniqueValues(rows, column) {
    if (!column) return [];
    return [...new Set(rows.map(row => String(row[column] || "").trim()).filter(Boolean))].sort();
}

function fillSelect(selectId, values, firstLabel = "All") {
    const select = document.getElementById(selectId);
    if (!select) return;
    const existing = select.value;
    select.replaceChildren();
    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = firstLabel;
    select.appendChild(allOption);
    values.forEach(value => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
    });
    if ([...select.options].some(option => option.value === existing)) select.value = existing;
}

function renderParkCards() {
    const container = document.getElementById("parkCards");
    if (!container) return;
    const search = document.getElementById("parkSearch").value.trim().toLowerCase();
    const state = document.getElementById("parkStateFilter").value;
    const type = document.getElementById("parkTypeFilter").value;
    const visibleParks = PARKS.filter(park =>
        (state === "all" || park.state === state) &&
        (type === "all" || park.type === type) &&
        `${park.name} ${park.state} ${park.species}`.toLowerCase().includes(search)
    );
    const fragment = document.createDocumentFragment();

    visibleParks.forEach(park => {
        const card = document.createElement("article");
        card.className = "dashboard-card park-info-card";
        const image = document.createElement("img");
        image.src = `./assets/${park.image}`;
        image.alt = `Wildlife photograph for ${park.name}`;
        image.loading = "lazy";
        const body = document.createElement("div");
        body.className = "park-info-body";
        const title = document.createElement("h3");
        title.textContent = park.name;
        const place = document.createElement("p");
        place.textContent = `${park.state} · ${park.type}`;
        const description = document.createElement("p");
        description.textContent = park.description;
        const species = document.createElement("p");
        species.textContent = `Wildlife: ${park.species}`;
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.parkId = park.id;
        button.textContent = "Locate on map";
        body.append(title, place, description, species, button);
        card.append(image, body);
        fragment.appendChild(card);
    });

    container.replaceChildren(fragment);
    const count = document.getElementById("parkResultCount");
    if (count) count.textContent = `${visibleParks.length} parks`;
    applyParkFilters();
}

function createPopupContent(park) {
    const popup = document.createElement("div");
    popup.className = "map-popup";
    const title = document.createElement("strong");
    title.textContent = park.name;
    const state = document.createElement("span");
    state.textContent = `${park.state} · ${park.type}`;
    const description = document.createElement("span");
    description.textContent = park.description;
    const species = document.createElement("span");
    species.textContent = `Wildlife: ${park.species}`;
    popup.append(title, state, description, species);
    return popup;
}

function initializeWildlifeMap() {
    const mapElement = document.getElementById("indiaMap");
    if (!mapElement || wildlifeMap) {
        if (wildlifeMap) wildlifeMap.invalidateSize();
        return;
    }
    if (!window.L) {
        mapElement.textContent = "The map library could not load. Check your internet connection and reload.";
        return;
    }

    wildlifeMap = window.L.map(mapElement, { scrollWheelZoom: false }).setView([22.7, 81], 4.5);
    const tileLayer = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });
    tileLayer.on("tileerror", () => {
        if (!mapTilesFailed) {
            mapTilesFailed = true;
            setStatus("OpenStreetMap tiles could not load. Check your internet connection; the park cards remain available.", true);
        }
    });
    tileLayer.addTo(wildlifeMap);

    parkMarkers = PARKS.map(park => {
        const marker = window.L.marker([park.lat, park.lng])
            .bindPopup(createPopupContent(park))
            .bindTooltip(park.name, { direction: "top" })
            .addTo(wildlifeMap);
        return { park, marker };
    });
    applyParkFilters();
    window.setTimeout(() => wildlifeMap.invalidateSize(), 50);
}

function applyParkFilters() {
    if (!wildlifeMap) return;
    const state = document.getElementById("parkStateFilter").value;
    const type = document.getElementById("parkTypeFilter").value;
    const search = document.getElementById("parkSearch").value.trim().toLowerCase();
    parkMarkers.forEach(({ park, marker }) => {
        const visible = (state === "all" || park.state === state) &&
            (type === "all" || park.type === type) &&
            `${park.name} ${park.state} ${park.species}`.toLowerCase().includes(search);
        if (visible && !wildlifeMap.hasLayer(marker)) marker.addTo(wildlifeMap);
        if (!visible && wildlifeMap.hasLayer(marker)) wildlifeMap.removeLayer(marker);
    });
}

function renderBookingTable() {
    const rows = datasets.annual || [];
    const stateColumn = findColumn(rows, ["State_UT", "State"]);
    const regionColumn = findColumn(rows, ["Region"]);
    const destinationColumn = findColumn(rows, ["Popular_Destination"]);
    const bookingsColumn = findColumn(rows, ["Estimated_Bookings", "Bookings"]);
    const region = document.getElementById("bookingRegionFilter").value;
    const search = document.getElementById("bookingSearch").value.trim().toLowerCase();
    const visible = rows.filter(row =>
        (region === "all" || row[regionColumn] === region) &&
        `${row[stateColumn]} ${row[destinationColumn]}`.toLowerCase().includes(search)
    ).sort((a, b) => (getNumber(b[bookingsColumn]) || 0) - (getNumber(a[bookingsColumn]) || 0));
    const tbody = document.getElementById("bookingTableBody");
    if (!visible.length) return appendTableMessage(tbody, "No matching booking records.", 4);
    tbody.replaceChildren();
    visible.forEach(row => appendTableRow(tbody, [
        row[stateColumn], row[regionColumn], row[destinationColumn], formatNumber(getNumber(row[bookingsColumn]))
    ]));

    const topRows = visible.slice(0, 10);
    renderPageChart("bookingsDetailChart", "bar", topRows.map(row => row[stateColumn]),
        topRows.map(row => getNumber(row[bookingsColumn])), "Estimated tourism bookings", { horizontal: true });
}

function renderBookingsPage() {
    const rows = datasets.annual || [];
    const stateColumn = findColumn(rows, ["State_UT", "State"]);
    const bookingsColumn = findColumn(rows, ["Estimated_Bookings", "Bookings"]);
    const totals = aggregateBy(rows, stateColumn, bookingsColumn).sort((a, b) => b.value - a.value);
    setTextContent("bookingsTotal", formatNumber(sum(rows, bookingsColumn)));
    setTextContent("bookingStateCount", String(totals.length));
    setTextContent("bookingTopState", totals.length ? totals[0].label : "—");
    setTextContent("bookingTopValue", totals.length ? `${formatNumber(totals[0].value)} estimated bookings` : "No estimates available");
    const regions = uniqueValues(rows, findColumn(rows, ["Region"]));
    fillSelect("bookingRegionFilter", regions, "All regions");
    renderBookingTable();
}

function speciesRows() {
    const rows = datasets.wildlife || [];
    const presentColumn = findColumn(rows, ["animal_present", "Animal Present"]);
    const speciesColumn = findColumn(rows, ["species_label", "Species"]);
    return rows.filter(row =>
        ["1", "true", "yes"].includes(String(row[presentColumn] || "").trim().toLowerCase()) &&
        row[speciesColumn] &&
        row[speciesColumn].trim().toLowerCase() !== "none"
    );
}

function renderSightingGallery(counts) {
    const container = document.getElementById("sightingGallery");
    const photos = [
        { name: "Bengal Tiger", species: ["tiger"], file: "tiger.jpg", caption: "Royal wildlife of India" },
        { name: "Indian Elephant", species: ["elephant"], file: "elephant.jpg", caption: "Gentle giant of the forest" },
        { name: "Indian Leopard", species: ["leopard"], file: "leopard.jpg", caption: "Master of camouflage" },
        { name: "Spotted Deer", species: ["deer"], file: "deer.jpg", caption: "Beauty of Indian forests" }
    ];
    const fragment = document.createDocumentFragment();
    photos.forEach(photo => {
        const key = photo.species[0];
        const card = document.createElement("div");
        card.className = "animal-card";
        const image = document.createElement("img");
        image.src = `./assets/${photo.file}`;
        image.alt = photo.name;
        image.loading = "lazy";
        const info = document.createElement("div");
        info.className = "animal-info";
        const title = document.createElement("h3");
        title.textContent = photo.name;
        const caption = document.createElement("p");
        caption.textContent = `${photo.caption} · ${counts.get(key) || 0} sample detections`;
        info.append(title, caption);
        card.append(image, info);
        fragment.appendChild(card);
    });
    container.replaceChildren(fragment);
}

function renderSightingsTable() {
    const rows = speciesRows();
    const speciesColumn = findColumn(rows, ["species_label", "Species"]);
    const presentColumn = findColumn(rows, ["animal_present", "Animal Present"]);
    const cameraColumn = findColumn(rows, ["camera_trap_id", "Camera Trap ID"]);
    const dateColumn = findColumn(rows, ["observation_date", "Observation Date"]);
    const recordColumn = findColumn(rows, ["record_type", "Record Type"]);
    const filter = document.getElementById("sightingSpeciesFilter").value;
    const search = document.getElementById("sightingSearch").value.trim().toLowerCase();
    const visible = rows.filter(row =>
        (filter === "all" || row[speciesColumn] === filter) &&
        `${row[speciesColumn]} ${row[cameraColumn]} ${row[dateColumn]}`.toLowerCase().includes(search)
    ).sort((a, b) => String(b[dateColumn]).localeCompare(String(a[dateColumn])));
    const tbody = document.getElementById("sightingTableBody");
    if (!visible.length) return appendTableMessage(tbody, "No matching camera-trap records.", 5);
    tbody.replaceChildren();
    visible.forEach(row => appendTableRow(tbody, [
        row[speciesColumn], row[presentColumn], row[cameraColumn], row[dateColumn], row[recordColumn]
    ]));
}

function renderSightingsPage() {
    const rows = speciesRows();
    const speciesColumn = findColumn(rows, ["species_label", "Species"]);
    const cameraColumn = findColumn(rows, ["camera_trap_id", "Camera Trap ID"]);
    const presentColumn = findColumn(rows, ["animal_present", "Animal Present"]);
    const counts = new Map(aggregateBy(rows, speciesColumn, presentColumn).map(item => [item.label.toLowerCase(), item.value]));
    const species = [...new Set(rows.map(row => row[speciesColumn]))].sort();
    const cameraCount = new Set(rows.map(row => row[cameraColumn]).filter(Boolean)).size;
    setTextContent("sightingTotal", formatNumber(rows.length));
    setTextContent("sightingSpeciesCount", String(species.length));
    setTextContent("sightingCameraCount", String(cameraCount));
    fillSelect("sightingSpeciesFilter", species, "All species");
    renderSightingGallery(counts);
    const selected = document.getElementById("sightingSpeciesFilter").value;
    const visibleSpecies = selected === "all" ? species : [selected];
    renderPageChart("sightingsDetailChart", "doughnut", visibleSpecies,
        visibleSpecies.map(name => counts.get(name.toLowerCase()) || 0), "Demo animal detections");
    renderSightingsTable();
}

function getRevenueData() {
    const year = document.getElementById("revenueYear").value;
    const rows = year === "2024" ? (datasets.annual || []) : (datasets.monthly || []);
    const revenueColumn = year === "2024"
        ? findColumn(rows, ["Estimated_Tourism_Revenue_INR_Crore"])
        : findColumn(rows, ["Tourism Revenue (INR Crore)", "Tourism_Revenue_INR_Crore"]);
    const stateColumn = findColumn(rows, ["State", "State_UT"]);
    const regionColumn = findColumn(rows, ["Region"]);
    if (year === "2024") return { year, rows, revenueColumn, stateColumn, regionColumn };

    const selectedPeriod = document.getElementById("revenuePeriod").value;
    const monthColumn = findColumn(rows, ["Month", "Month_Name"]);
    const dateColumn = findColumn(rows, ["Date"]);
    const numberColumn = findColumn(rows, ["Month_Number", "Month Number"]);
    const filteredRows = selectedPeriod === "all" ? rows : rows.filter(row =>
        monthForRow(row, monthColumn, dateColumn, numberColumn) === selectedPeriod
    );
    return { year, rows: filteredRows, sourceRows: rows, revenueColumn, stateColumn, regionColumn };
}

function renderRevenueTable() {
    const { rows, stateColumn, regionColumn, revenueColumn } = getRevenueData();
    const search = document.getElementById("revenueSearch").value.trim().toLowerCase();
    const totals = new Map();
    rows.forEach(row => {
        const state = String(row[stateColumn] || "").trim();
        const region = String(row[regionColumn] || "").trim();
        const amount = getNumber(row[revenueColumn]);
        if (!state || amount === null) return;
        const item = totals.get(state) || { region, amount: 0 };
        item.amount += amount;
        totals.set(state, item);
    });
    const visible = [...totals.entries()].filter(([state, item]) =>
        `${state} ${item.region}`.toLowerCase().includes(search)
    ).sort((a, b) => b[1].amount - a[1].amount);
    const tbody = document.getElementById("revenueTableBody");
    if (!visible.length) return appendTableMessage(tbody, "No matching state revenue records.", 3);
    tbody.replaceChildren();
    visible.forEach(([state, item]) => appendTableRow(tbody, [
        state, item.region, item.amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    ]));
}

function renderRevenuePage() {
    const period = document.getElementById("revenuePeriod");
    const year = document.getElementById("revenueYear").value;
    period.disabled = year === "2024";
    if (year === "2024") period.value = "all";
    const result = getRevenueData();
    const totalRevenue = sum(result.rows, result.revenueColumn);
    const stateTotals = aggregateBy(result.rows, result.stateColumn, result.revenueColumn);
    setTextContent("revenueTotal", totalRevenue === null ? "—" : `₹${totalRevenue.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    setTextContent("revenueStateCount", String(stateTotals.length));
    setTextContent("revenuePeriodLabel", year === "2024" ? "Annual · 2024" : period.value === "all" ? "All months · 2025" : `${period.value} · 2025`);

    if (year === "2024") {
        const topStates = stateTotals.sort((a, b) => b.value - a.value).slice(0, 15);
        renderPageChart("revenueDetailChart", "bar", topStates.map(item => item.label),
            topStates.map(item => item.value), "Revenue (INR crore)");
        document.querySelector("#revenue .page-panel .page-note").textContent = "Top state-wise annual estimates · INR crore.";
    } else {
        const revenueTrend = aggregateMonthly(result.sourceRows, result.revenueColumn);
        renderPageChart("revenueDetailChart", "line", revenueTrend.map(item => item.label),
            revenueTrend.map(item => item.value), "Revenue (INR crore)", { fill: true });
        document.querySelector("#revenue .page-panel .page-note").textContent = "Monthly estimated tourism revenue · INR crore.";
    }
    renderRevenueTable();
}

function setTextContent(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function renderReportsPage() {
    setTextContent("reportTourismRows", formatNumber((datasets.annual || []).length + (datasets.monthly || []).length));
    setTextContent("reportWildlifeRows", formatNumber((datasets.wildlife || []).length));
    setTextContent("reportStateCount", String(uniqueValues(datasets.annual || [], findColumn(datasets.annual || [], ["State_UT", "State"])).length));
}

function renderActivePage(route = currentRoute) {
    if (!datasets.monthly || !datasets.annual || !datasets.wildlife) return;
    if (route === "parks") {
        if (!document.getElementById("parkStateFilter").options.length || document.getElementById("parkStateFilter").options.length === 1) {
            fillSelect("parkStateFilter", [...new Set(PARKS.map(park => park.state))].sort(), "All states");
        }
        renderParkCards();
        initializeWildlifeMap();
    } else if (route === "bookings") {
        renderBookingsPage();
    } else if (route === "sightings") {
        renderSightingsPage();
    } else if (route === "revenue") {
        renderRevenuePage();
    } else if (route === "reports") {
        renderReportsPage();
    }
}

function populateRevenuePeriods() {
    const rows = datasets.monthly || [];
    const monthColumn = findColumn(rows, ["Month", "Month_Name"]);
    const dateColumn = findColumn(rows, ["Date"]);
    const monthNumberColumn = findColumn(rows, ["Month_Number", "Month Number"]);
    const months = [...new Set(rows.map(row =>
        monthForRow(row, monthColumn, dateColumn, monthNumberColumn)
    ).filter(Boolean))].sort((a, b) => MONTHS.indexOf(a) - MONTHS.indexOf(b));
    ["revenuePeriod", "settingsPeriod"].forEach(id => fillSelect(id, months, "All available months"));
}

function csvEscape(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadCSV(filename, rows) {
    const text = rows.map(row => row.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF", text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function downloadSource(path, filename) {
    const link = document.createElement("a");
    link.href = path;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function applySettings() {
    const settings = {
        year: document.getElementById("settingsYear").value,
        period: document.getElementById("settingsPeriod").value,
        theme: document.getElementById("settingsTheme").value,
        density: document.getElementById("settingsDensity").value
    };
    localStorage.setItem("wildlife-tourism-preferences", JSON.stringify(settings));
    applySavedSettings(settings);
    setTextContent("settingsFeedback", "Settings applied and saved.");
}

function applySavedSettings(settings) {
    document.getElementById("revenueYear").value = settings.year;
    document.getElementById("revenuePeriod").value = settings.year === "2024" ? "all" : settings.period;
    document.getElementById("settingsYear").value = settings.year;
    document.getElementById("settingsPeriod").value = settings.period;
    document.getElementById("settingsTheme").value = settings.theme;
    document.getElementById("settingsDensity").value = settings.density;
    document.getElementById("monthFilter").value = settings.year === "2025" ? settings.period : "all";
    document.body.classList.toggle("theme-light", settings.theme === "light");
    document.body.classList.toggle("theme-night", settings.theme === "night");
    document.body.classList.toggle("compact-display", settings.density === "compact");
    updateDashboard();
    if (currentRoute === "revenue") renderRevenuePage();
}

function setupPageActions() {
    document.getElementById("parkStateFilter").addEventListener("change", renderParkCards);
    document.getElementById("parkTypeFilter").addEventListener("change", renderParkCards);
    document.getElementById("parkSearch").addEventListener("input", renderParkCards);
    document.getElementById("parkCards").addEventListener("click", event => {
        const button = event.target.closest("button[data-park-id]");
        if (!button || !wildlifeMap) return;
        const park = PARKS.find(item => item.id === button.dataset.parkId);
        const marker = parkMarkers.find(item => item.park.id === button.dataset.parkId);
        if (park && marker) {
            wildlifeMap.flyTo([park.lat, park.lng], 7, { duration: 0.6 });
            marker.marker.openPopup();
        }
    });
    document.getElementById("bookingRegionFilter").addEventListener("change", renderBookingTable);
    document.getElementById("bookingSearch").addEventListener("input", renderBookingTable);
    document.getElementById("sightingSpeciesFilter").addEventListener("change", renderSightingsPage);
    document.getElementById("sightingSearch").addEventListener("input", renderSightingsTable);
    document.getElementById("revenueYear").addEventListener("change", renderRevenuePage);
    document.getElementById("revenuePeriod").addEventListener("change", renderRevenuePage);
    document.getElementById("revenueSearch").addEventListener("input", renderRevenueTable);
    document.getElementById("settingsYear").addEventListener("change", event => {
        const period = document.getElementById("settingsPeriod");
        if (event.target.value === "2024") period.value = "all";
    });
    document.getElementById("applySettings").addEventListener("click", applySettings);
    document.getElementById("resetSettings").addEventListener("click", () => {
        localStorage.removeItem("wildlife-tourism-preferences");
        applySavedSettings({ year: "2025", period: "all", theme: "forest", density: "comfortable" });
        setTextContent("settingsFeedback", "Settings reset to defaults.");
    });
    document.getElementById("downloadAnnual").addEventListener("click", () => downloadSource(DATA_FILES.annual, "01_indian_tourism_annual_sample.csv"));
    document.getElementById("downloadMonthly").addEventListener("click", () => downloadSource(DATA_FILES.monthly, "03_india_tourism_2025_monthly_sample.csv"));
    document.getElementById("downloadWildlife").addEventListener("click", () => downloadSource(DATA_FILES.wildlife, "02_iwildcam_2018_demo_annotations.csv"));
    document.getElementById("exportReport").addEventListener("click", () => {
        const rows = [
            ["Metric", "Value", "Source"],
            ["Monthly tourism records", (datasets.monthly || []).length, DATA_FILES.monthly],
            ["Annual tourism records", (datasets.annual || []).length, DATA_FILES.annual],
            ["Synthetic wildlife annotations", (datasets.wildlife || []).length, DATA_FILES.wildlife],
            ["Tourism visitors (selected month)", document.getElementById("visitorsKpi").textContent, "2025 monthly sample"],
            ["Estimated tourism bookings", document.getElementById("bookingsKpi").textContent, "General tourism estimate; not necessarily safari bookings"],
            ["Animal-present demo detections", speciesRows().length, "Synthetic wildlife annotations"],
            ["Estimated tourism revenue (INR crore)", document.getElementById("revenueKpi").textContent, "2025 monthly sample"]
        ];
        downloadCSV("wildlife-tourism-dashboard-report.csv", rows);
    });
    document.getElementById("printReport").addEventListener("click", () => {
        document.body.classList.add("print-report");
        window.addEventListener("afterprint", () => document.body.classList.remove("print-report"), { once: true });
        window.print();
    });
}

function loadSavedSettings() {
    const defaults = { year: "2025", period: "all", theme: "forest", density: "comfortable" };
    try {
        const saved = localStorage.getItem("wildlife-tourism-preferences");
        if (!saved) return defaults;
        return { ...defaults, ...JSON.parse(saved) };
    } catch (error) {
        console.error("Could not load saved dashboard settings.", error);
        return defaults;
    }
}

async function loadDataset() {
    setStatus("Loading CSV datasets...");
    const results = await Promise.all(Object.entries(DATA_FILES).map(async ([name, path]) => {
        try {
            datasets[name] = await loadCSV(path);
            return null;
        } catch (error) {
            console.error(`Could not load ${path}`, error);
            return error.message;
        }
    }));

    populateMonthFilter(datasets.monthly || []);
    populateRevenuePeriods();
    updateDashboard();
    const savedSettings = loadSavedSettings();
    document.getElementById("settingsYear").value = savedSettings.year;
    document.getElementById("settingsPeriod").value = savedSettings.period;
    document.getElementById("settingsTheme").value = savedSettings.theme;
    document.getElementById("settingsDensity").value = savedSettings.density;
    applySavedSettings(savedSettings);
    renderReportsPage();
    renderActivePage(currentRoute);

    const errors = results.filter(Boolean);
    if (errors.length) {
        setStatus(`Some CSV data could not be loaded: ${errors.join(" ")}`, true);
        return;
    }
    setStatus(
        `Loaded ${datasets.monthly.length} monthly tourism rows, ${datasets.annual.length} annual tourism rows, and ${datasets.wildlife.length} synthetic wildlife rows. Booking figures are general tourism estimates, not safari bookings.`
    );
}

function updateSidebarNavigation(sectionId, shouldScroll = false) {
    const target = document.querySelector(`.page-view#${sectionId}`);
    if (!target) return;

    document.querySelectorAll(".sidebar nav a[data-section]").forEach(link => {
        const isActive = link.dataset.section === sectionId;
        link.classList.toggle("active", isActive);
        if (isActive) {
            link.setAttribute("aria-current", "page");
        } else {
            link.removeAttribute("aria-current");
        }
    });

    document.querySelectorAll(".page-view").forEach(page => {
        page.classList.toggle("active", page === target);
    });

    currentRoute = sectionId;
    if (shouldScroll) {
        window.scrollTo({ top: 0, behavior: "smooth" });
    }
    window.setTimeout(() => renderActivePage(sectionId), 60);
}

function syncSidebarNavigationFromHash(shouldScroll = false) {
    const requestedId = decodeURIComponent(window.location.hash.slice(1));
    const link = [...document.querySelectorAll(".sidebar nav a[data-section]")]
        .find(item => item.dataset.section === requestedId);
    const sectionId = link ? requestedId : "dashboard";

    if (!link && window.location.hash) {
        window.history.replaceState(null, "", "#dashboard");
    }

    updateSidebarNavigation(sectionId, shouldScroll);
}

function initializeSidebarNavigation() {
    const links = document.querySelectorAll(".sidebar nav a[data-section]");

    links.forEach(link => {
        link.addEventListener("click", event => {
            event.preventDefault();
            const sectionId = link.dataset.section;
            const hash = `#${sectionId}`;

            if (window.location.hash !== hash) {
                window.history.pushState(null, "", hash);
            }

            updateSidebarNavigation(sectionId, true);
        });
    });

    window.addEventListener("popstate", () => syncSidebarNavigationFromHash(true));
    window.addEventListener("hashchange", () => syncSidebarNavigationFromHash(true));
    syncSidebarNavigationFromHash(Boolean(window.location.hash));
}

document.addEventListener("DOMContentLoaded", () => {
    initializeSidebarNavigation();
    setupPageActions();
    document.getElementById("monthFilter").addEventListener("change", updateDashboard);
    loadDataset();
});
