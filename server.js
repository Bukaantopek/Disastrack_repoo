const mqtt = require('mqtt');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MQTT_HOST = 'mqtt://192.168.100.147:1883';
const PORT = 8080;

const mqttClient = mqtt.connect(MQTT_HOST, {
    reconnectPeriod: 3000,
    connectTimeout: 10000
});

const clients = [];

mqttClient.on('connect', () => {
    console.log('MQTT CONNECTED');

    mqttClient.subscribe('disastrack/v1/#', err => {
        if (err) {
            console.log('MQTT SUBSCRIBE ERROR:', err.message);
        } else {
            console.log('MQTT SUBSCRIBED: disastrack/v1/#');
        }
    });
});

mqttClient.on('reconnect', () => {
    console.log('MQTT RECONNECTING...');
});

mqttClient.on('offline', () => {
    console.log('MQTT OFFLINE');
});

mqttClient.on('close', () => {
    console.log('MQTT DISCONNECTED');
});

mqttClient.on('error', err => {
    console.log('MQTT ERROR:', err.message);
});

mqttClient.on('message', (topic, message) => {

    let data;

    try {
        data = JSON.parse(message.toString());
    } catch (e) {
        console.log('JSON ERROR:', topic);
        return;
    }

    const event = {
        topic: topic,
        data: data
    };

    clients.forEach(client => {
        try {
            client.write(
                `data: ${JSON.stringify(event)}\n\n`
            );
        } catch (e) {}
    });

    console.log('MQTT:', topic, data);
});

const server = http.createServer((req, res) => {

    if (req.url === '/events') {

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        res.write('\n');

        clients.push(res);

        req.on('close', () => {
            const index = clients.indexOf(res);

            if (index !== -1) {
                clients.splice(index, 1);
            }
        });

        return;
    }

    let file;

    if (req.url === '/') {
        file = path.join(__dirname, 'index.html');
    } else {
        file = path.join(
            __dirname,
            req.url.substring(1)
        );
    }

    fs.readFile(file, (err, data) => {

        if (err) {
            res.writeHead(404);
            res.end('404 Not Found');
            return;
        }

        res.writeHead(200);
        res.end(data);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('================================');
    console.log(' DISASTRACK COMMAND CENTER');
    console.log('================================');
    console.log('Server : http://localhost:' + PORT);
    console.log('MQTT   : ' + MQTT_HOST);
    console.log('================================');
});