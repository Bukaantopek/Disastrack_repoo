/* =========================================================
   DISASTRACK COMMAND CENTER
   APP.JS  (versi perbaikan)

   Perubahan utama:
   - Station dianggap ONLINE dari heartbeat (walau GPS belum lock)
   - Tidak lagi membuat tracker "hantu" dari pesan station
   - Tipe korban (Human/Animal) & status evakuasi dari station
   - Escape HTML (broker HiveMQ itu publik, siapa saja bisa publish)
   - Popup marker tidak menutup tiap update
   Struktur & parsing data TRACKER tidak diubah.
   ========================================================= */

const MQTT_BROKER = "wss://broker.hivemq.com:8884/mqtt";

const TOPIC_TRACKER = "mencarigps/disastrack/v1/tracker";
const TOPIC_STATION = "mencarigps/disastrack/v1/station";

const STATION_TIMEOUT = 10000;   // ms tanpa heartbeat -> OFFLINE
const LOCK_ZOOM = 18;

let mqttClient = null;

let trackerMap = null;
let stationMap = null;

const trackerData = {};
const stationData = {};

const trackerMarkers = {};
const stationMarkers = {};

/* Tandai device yang sudah di-zoom saat GPS lock */
const trackerZoomed = {};
const stationZoomed = {};

/* Info dari station untuk tracker tertentu */
const evacByTracker = {};
const typeByTracker = {};
const typesByTracker = {};   // per-korban dari station, mis. "HA-H" (urutan: kritis, berat, ringan)

let trackerIcons = {};
let stationIcon = null;


/* =========================================================
   HELPER
   ========================================================= */

function get(id) {
    return document.getElementById(id);
}

function setText(id, value) {
    const el = get(id);
    if (el) {
        el.textContent = value;
    }
}

function esc(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/[&<>"']/g, function (c) {
            return {
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;"
            }[c];
        });
}

function numberValue(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function boolValue(value) {
    if (value === true || value === 1) {
        return true;
    }

    if (typeof value === "string") {
        return value.toLowerCase() === "true" || value === "1";
    }

    return false;
}

function validGPS(lat, lon) {
    return (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat !== 0 &&
        lon !== 0 &&
        lat >= -90 &&
        lat <= 90 &&
        lon >= -180 &&
        lon <= 180
    );
}

function stationOnline(data) {
    return Date.now() - data.receivedAt < STATION_TIMEOUT;
}

function typeLabel(type) {
    if (type === "human") return "Human";
    if (type === "animal") return "Animal";
    return "-";
}

/* Tipe korban: prioritas dari station, fallback ke data tracker */
function getType(id, data) {
    const t = typeByTracker[id] || String(data.type || "").toLowerCase();
    return t;
}

/* Evakuasi: prioritas dari station */
function getEvac(id, data) {

    /* Kalau station bilang sudah evakuasi, semua korban tracker itu dihitung */
    if (evacByTracker[id] !== undefined) {
        return evacByTracker[id] ? numberValue(data.total) : 0;
    }

    return numberValue(data.evacuated);
}

/* Jumlah Human / Animal untuk satu tracker */
function typeCounts(id, data) {

    const s = typesByTracker[id];

    if (typeof s === "string" && s.length > 0) {

        let h = 0;
        let a = 0;

        for (const c of s) {
            if (c === "H") h++;
            else if (c === "A") a++;
        }

        return { human: h, animal: a };
    }

    const t = getType(id, data);
    const total = numberValue(data.total);

    return {
        human: t === "human" ? total : 0,
        animal: t === "animal" ? total : 0
    };
}

/* Teks tipe untuk satu baris kondisi. index: 0 kritis, 1 berat, 2 ringan */
function severityTypeText(id, data, index) {

    const s = typesByTracker[id];

    if (typeof s !== "string" || s.length === 0) {
        return typeLabel(getType(id, data));
    }

    const crit = numberValue(data.critical);
    const sev = numberValue(data.severe);
    const min = numberValue(data.minor);

    const starts = [0, crit, crit + sev];
    const lens = [crit, sev, min];

    const slice = s.substr(starts[index], lens[index]);

    let h = 0;
    let a = 0;

    for (const c of slice) {
        if (c === "H") h++;
        else if (c === "A") a++;
    }

    const parts = [];

    if (h) parts.push("Human " + h);
    if (a) parts.push("Animal " + a);

    return parts.length ? parts.join(", ") : "-";
}

function refreshUI() {
    updateDashboard();
    updateDeviceList();
    updateVictimTable();
}


/* =========================================================
   MQTT STATUS
   ========================================================= */

function mqttStatus(connected, message) {

    const dot = get("mqttDot");
    const text = get("mqttText");

    if (dot) {
        dot.style.backgroundColor = connected ? "#22c55e" : "#ef4444";
    }

    if (text) {
        text.textContent = message;
    }
}


/* =========================================================
   MARKER ICON
   ========================================================= */

function createMarkerIcon(color) {

    return L.divIcon({

        className: "",

        html:
            '<div style="' +
            'width:24px;' +
            'height:24px;' +
            'border-radius:50% 50% 50% 0;' +
            'background:' + color + ';' +
            'border:3px solid white;' +
            'box-shadow:0 2px 7px rgba(0,0,0,.35);' +
            'transform:rotate(-45deg);' +
            '">' +

            '<div style="' +
            'width:8px;' +
            'height:8px;' +
            'background:white;' +
            'border-radius:50%;' +
            'margin:5px;' +
            '">' +

            '</div>' +
            '</div>',

        iconSize: [24, 24],
        iconAnchor: [12, 24],
        popupAnchor: [0, -24]
    });
}


function initIcons() {

    trackerIcons.none = createMarkerIcon("#7e22ce");
    trackerIcons.minor = createMarkerIcon("#22c55e");
    trackerIcons.severe = createMarkerIcon("#eab308");
    trackerIcons.critical = createMarkerIcon("#dc2626");

    stationIcon = createMarkerIcon("#2563eb");
}


/* =========================================================
   MAP
   ========================================================= */

function makeMap(elementId) {

    const map = L.map(elementId).setView([-2.9909, 104.7566], 13);

    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            maxZoom: 19,
            attribution: "&copy; OpenStreetMap"
        }
    ).addTo(map);

    return map;
}


function initMaps() {

    if (get("trackerMap")) {
        trackerMap = makeMap("trackerMap");
    }

    if (get("stationMap")) {
        stationMap = makeMap("stationMap");
    }

    setTimeout(function () {

        if (trackerMap) {
            trackerMap.invalidateSize();
        }

        if (stationMap) {
            stationMap.invalidateSize();
        }

    }, 500);
}


/* Popup: update isi tanpa menutup popup yang sedang terbuka */
function setMarkerPopup(marker, html) {

    if (marker.getPopup()) {
        marker.setPopupContent(html);
    } else {
        marker.bindPopup(html);
    }
}


/* =========================================================
   TRACKER GPS  (tidak diubah)
   ========================================================= */

function getTrackerGPS(data) {

    const gps =
        data.gps !== undefined
            ? boolValue(data.gps)
            : boolValue(data.gpsValid);

    const lat =
        data.lat !== undefined
            ? numberValue(data.lat)
            : numberValue(data.latitude);

    const lon =
        data.lon !== undefined
            ? numberValue(data.lon)
            : numberValue(data.longitude);

    return {
        valid: gps && validGPS(lat, lon),
        lat: lat,
        lon: lon
    };
}


/* =========================================================
   STATION GPS
   ========================================================= */

function getStationGPS(data) {

    const gps =
        data.gpsValid !== undefined
            ? boolValue(data.gpsValid)
            : boolValue(data.gps);

    const lat =
        data.latitude !== undefined
            ? numberValue(data.latitude)
            : numberValue(data.lat);

    const lon =
        data.longitude !== undefined
            ? numberValue(data.longitude)
            : numberValue(data.lon);

    return {
        valid: gps && validGPS(lat, lon),
        lat: lat,
        lon: lon
    };
}


/* =========================================================
   TRACKER SEVERITY  (tidak diubah)
   ========================================================= */

function getSeverity(data) {

    if (numberValue(data.critical) > 0) {
        return "critical";
    }

    if (numberValue(data.severe) > 0) {
        return "severe";
    }

    if (numberValue(data.minor) > 0) {
        return "minor";
    }

    return "none";
}


function severityText(severity) {

    if (severity === "critical") {
        return "Kritis";
    }

    if (severity === "severe") {
        return "Berat";
    }

    if (severity === "minor") {
        return "Ringan";
    }

    return "Tidak ada korban";
}


/* =========================================================
   UPDATE TRACKER MARKER
   ========================================================= */

function updateTrackerMarker(data) {

    if (!trackerMap) {
        return;
    }

    const id =
        data.trackerId ||
        data.device ||
        data.id ||
        "T001";

    const gps = getTrackerGPS(data);

    /* GPS tracker tidak valid -> marker tidak ditampilkan */
    if (!gps.valid) {

        if (trackerMarkers[id]) {
            trackerMap.removeLayer(trackerMarkers[id]);
            delete trackerMarkers[id];
        }

        delete trackerZoomed[id];

        return;
    }

    /* Tidak ada korban = UNGU */
    const severity = getSeverity(data);
    const icon = trackerIcons[severity];

    const popup =
        "<b>TRACKER " + esc(id) + "</b><br>" +
        "Status: " + severityText(severity) + "<br>" +
        "Ringan: " + numberValue(data.minor) + "<br>" +
        "Berat: " + numberValue(data.severe) + "<br>" +
        "Kritis: " + numberValue(data.critical) + "<br>" +
        "Total: " + numberValue(data.total) + "<br>" +
        "Tipe: Human " + typeCounts(id, data).human + " / Animal " + typeCounts(id, data).animal + "<br>" +
        "Evakuasi: " + (getEvac(id, data) > 0 ? "Sudah" : "Belum") + "<br>" +
        "GPS: Valid<br>" +
        "Lat: " + gps.lat.toFixed(6) + "<br>" +
        "Lon: " + gps.lon.toFixed(6);

    if (!trackerMarkers[id]) {

        trackerMarkers[id] =
            L.marker([gps.lat, gps.lon], { icon: icon })
             .addTo(trackerMap);

    } else {

        trackerMarkers[id].setLatLng([gps.lat, gps.lon]);
        trackerMarkers[id].setIcon(icon);
    }

    setMarkerPopup(trackerMarkers[id], popup);

    /* GPS baru lock -> langsung zoom ke lokasi */
    if (!trackerZoomed[id]) {

        trackerMap.flyTo(
            [gps.lat, gps.lon],
            LOCK_ZOOM,
            { duration: 1.2 }
        );

        trackerZoomed[id] = true;
    }
}


/* =========================================================
   UPDATE STATION MARKER
   ========================================================= */

function updateStationMarker(data) {

    if (!stationMap) {
        return;
    }

    const id =
        data.stationId ||
        data.device ||
        data.id ||
        "S001";

    const gps = getStationGPS(data);

    /* Marker station hanya muncul jika GPS valid */
    if (!gps.valid) {

        if (stationMarkers[id]) {
            stationMap.removeLayer(stationMarkers[id]);
            delete stationMarkers[id];
        }

        delete stationZoomed[id];

        return;
    }

    const popup =
        "<b>STATION " + esc(id) + "</b><br>" +
        "GPS: Valid<br>" +
        "Satellites: " + numberValue(data.satellites) + "<br>" +
        "Tracker: " + esc(data.trackerId || "-") + "<br>" +
        "Total: " + numberValue(data.total) + "<br>" +
        "Human: " + numberValue(data.human) + " / Animal: " + numberValue(data.animal) + "<br>" +
        "Evakuasi: " + (boolValue(data.evacuated) ? "Sudah" : "Belum") + "<br>" +
        "Lat: " + gps.lat.toFixed(6) + "<br>" +
        "Lon: " + gps.lon.toFixed(6);

    if (!stationMarkers[id]) {

        stationMarkers[id] =
            L.marker([gps.lat, gps.lon], { icon: stationIcon })
             .addTo(stationMap);

    } else {

        stationMarkers[id].setLatLng([gps.lat, gps.lon]);
    }

    setMarkerPopup(stationMarkers[id], popup);

    /* GPS baru lock -> langsung zoom ke lokasi */
    if (!stationZoomed[id]) {

        stationMap.flyTo(
            [gps.lat, gps.lon],
            LOCK_ZOOM,
            { duration: 1.2 }
        );

        stationZoomed[id] = true;
    }
}


/* =========================================================
   PROCESS TRACKER  (tidak diubah)
   ========================================================= */

function processTracker(data) {

    const id =
        data.trackerId ||
        data.device ||
        data.id ||
        "T001";

    trackerData[id] = {
        ...data,
        receivedAt: Date.now()
    };

    updateTrackerMarker(trackerData[id]);

    refreshUI();
}


/* =========================================================
   PROCESS STATION
   ========================================================= */

function processStation(data) {

    const id =
        data.stationId ||
        data.device ||
        data.id ||
        "S001";

    stationData[id] = {
        ...data,
        receivedAt: Date.now()
    };

    updateStationMarker(stationData[id]);

    /*
       Hubungkan status evakuasi & tipe korban dari station
       ke tracker. Disimpan terpisah, sehingga tidak membuat
       entri tracker kosong kalau tracker belum pernah kirim.
    */
    const trackerId = data.trackerId;

    if (trackerId) {

        if (data.evacuated !== undefined) {
            evacByTracker[trackerId] = boolValue(data.evacuated) ? 1 : 0;
        }

        if (typeof data.victimTypes === "string" && data.victimTypes.length > 0) {
            typesByTracker[trackerId] = data.victimTypes;
        } else {
            delete typesByTracker[trackerId];
        }

        if (boolValue(data.victimTypeSelected)) {
            typeByTracker[trackerId] =
                String(data.victimType || "").toLowerCase();
        } else {
            delete typeByTracker[trackerId];
        }

        if (trackerData[trackerId]) {
            updateTrackerMarker(trackerData[trackerId]);
        }
    }

    refreshUI();
}


/* =========================================================
   MQTT CONNECT
   ========================================================= */

function connectMQTT() {

    if (typeof mqtt === "undefined") {

        mqttStatus(false, "MQTT library tidak ditemukan");
        console.error("mqtt.min.js tidak ditemukan.");

        return;
    }

    mqttStatus(false, "Connecting...");

    const clientId =
        "DISASTRACK-" +
        Math.random().toString(16).substring(2, 10);

    mqttClient = mqtt.connect(
        MQTT_BROKER,
        {
            clientId: clientId,
            clean: true,
            connectTimeout: 10000,
            reconnectPeriod: 3000
        }
    );

    mqttClient.on("connect", function () {

        console.log("MQTT CONNECTED");
        mqttStatus(true, "MQTT Connected");

        [TOPIC_TRACKER, TOPIC_STATION].forEach(function (topic) {

            mqttClient.subscribe(topic, function (error) {

                if (error) {
                    console.error("Subscribe error:", topic, error);
                } else {
                    console.log("SUBSCRIBED:", topic);
                }
            });
        });
    });

    mqttClient.on("reconnect", function () {
        mqttStatus(false, "Reconnecting...");
    });

    mqttClient.on("offline", function () {
        mqttStatus(false, "Offline");
    });

    mqttClient.on("close", function () {
        mqttStatus(false, "Disconnected");
    });

    mqttClient.on("error", function (error) {
        console.error("MQTT ERROR:", error);
        mqttStatus(false, "MQTT Error");
    });

    mqttClient.on("message", function (topic, message) {

        const raw = message.toString();

        console.log("MQTT MESSAGE:", topic, raw);

        let data;

        try {
            data = JSON.parse(raw);
        } catch (error) {
            console.error("JSON tidak valid:", raw);
            return;
        }

        if (!data || typeof data !== "object") {
            return;
        }

        if (topic === TOPIC_TRACKER) {
            processTracker(data);
            return;
        }

        if (topic === TOPIC_STATION) {
            processStation(data);
            return;
        }
    });
}


/* =========================================================
   DASHBOARD
   ========================================================= */

function updateDashboard() {

    const trackerCount = Object.keys(trackerData).length;

    /* Station dihitung aktif kalau heartbeat masih baru */
    const stationCount =
        Object.values(stationData).filter(stationOnline).length;

    let victimCount = 0;
    let evacCount = 0;
    let sumMinor = 0;
    let sumSevere = 0;
    let sumCritical = 0;

    Object.entries(trackerData).forEach(function ([id, data]) {

        victimCount += numberValue(data.total);
        evacCount += getEvac(id, data);

        sumMinor += numberValue(data.minor);
        sumSevere += numberValue(data.severe);
        sumCritical += numberValue(data.critical);
    });

    setText("sumMinor", sumMinor);
    setText("sumSevere", sumSevere);
    setText("sumCritical", sumCritical);

    setText("trackerCount", trackerCount);
    setText("stationCount", stationCount);

    setText("victimCount", victimCount);
    setText("evacCount", evacCount);
    setText("totalVictims", victimCount);

    setText("humanCount", countType("human"));
    setText("animalCount", countType("animal"));

    setText("evacuatedCount", evacCount);
}


function countType(type) {

    let count = 0;

    Object.entries(trackerData).forEach(function ([id, data]) {

        count += typeCounts(id, data)[type];
    });

    return count;
}


/* =========================================================
   DEVICE LIST
   ========================================================= */

function deviceRow(type, id, gps, state) {

    /* state: "online" | "waiting" | "offline" */

    let label = "WAITING";
    let style = "";

    if (state === "online") {
        label = "ONLINE";
    } else if (state === "offline") {
        label = "OFFLINE";
        style = ' style="background:#ef4444;color:#fff"';
    }

    const sub =
        gps.valid
            ? gps.lat.toFixed(5) + ", " + gps.lon.toFixed(5)
            : (state === "waiting" && type === "STATION"
                ? "Online, waiting for GPS"
                : "Waiting for data");

    return (
        '<div class="device-row">' +

        '<div>' +
        '<div class="device-title">' +
        esc(id) + " - " + type +
        "</div>" +
        '<div class="device-sub">GPS: ' + esc(sub) + "</div>" +
        "</div>" +

        '<span class="status-badge ' +
        (state === "online" ? "online" : "waiting") + '"' +
        style + ">" +
        label +
        "</span>" +

        "</div>"
    );
}


function updateDeviceList() {

    const container = get("devices");

    if (!container) {
        return;
    }

    let html = "";

    Object.entries(trackerData).forEach(function ([id, data]) {

        const gps = getTrackerGPS(data);

        html += deviceRow(
            "TRACKER",
            id,
            gps,
            gps.valid ? "online" : "waiting"
        );
    });

    Object.entries(stationData).forEach(function ([id, data]) {

        const gps = getStationGPS(data);

        let state = "offline";

        if (stationOnline(data)) {
            state = gps.valid ? "online" : "waiting";
        }

        html += deviceRow("STATION", id, gps, state);
    });

    container.innerHTML =
        html ||
        '<div class="empty">Waiting for devices...</div>';
}


/* =========================================================
   VICTIM TABLE
   ========================================================= */

function updateVictimTable() {

    const tbody = get("victims");

    if (!tbody) {
        return;
    }

    tbody.innerHTML = "";

    Object.entries(trackerData).forEach(function ([id, data]) {

        if (numberValue(data.total) <= 0) {
            return;
        }

        const rows = [
            ["Ringan", numberValue(data.minor), 2],
            ["Berat", numberValue(data.severe), 1],
            ["Kritis", numberValue(data.critical), 0]
        ];

        rows.forEach(function (row) {

            const severity = row[0];
            const count = row[1];

            if (count <= 0) {
                return;
            }

            const tr = document.createElement("tr");

            tr.innerHTML =
                "<td>" + esc(id) + "</td>" +
                "<td>" + count + "</td>" +
                "<td>" + severity + "</td>" +
                "<td>" + esc(severityTypeText(id, data, row[2])) + "</td>" +
                "<td>" +
                (getEvac(id, data) > 0 ? "Dievakuasi" : "Ditemukan") +
                "</td>";

            tbody.appendChild(tr);
        });
    });
}


/* =========================================================
   CLOCK
   ========================================================= */

function updateClock() {

    const clock = get("clock");

    if (!clock) {
        return;
    }

    clock.textContent =
        new Date().toLocaleString(
            "id-ID",
            {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            }
        );
}


/* =========================================================
   TICK: cek station online/offline tiap 2 detik
   ========================================================= */

function tick() {

    Object.entries(stationMarkers).forEach(function ([id, marker]) {

        const data = stationData[id];

        if (data) {
            marker.setOpacity(stationOnline(data) ? 1 : 0.4);
        }
    });

    updateDashboard();
    updateDeviceList();
}


/* =========================================================
   START
   ========================================================= */

document.addEventListener("DOMContentLoaded", function () {

    initIcons();
    initMaps();

    updateClock();
    setInterval(updateClock, 1000);

    setInterval(tick, 2000);

    connectMQTT();
});


/* =========================================================
   DEBUG
   ========================================================= */

window.disastrack = {

    trackerData: trackerData,
    stationData: stationData,

    trackerMarkers: trackerMarkers,
    stationMarkers: stationMarkers,

    evacByTracker: evacByTracker,
    typeByTracker: typeByTracker,
    typesByTracker: typesByTracker,

    TOPIC_TRACKER: TOPIC_TRACKER,
    TOPIC_STATION: TOPIC_STATION
};