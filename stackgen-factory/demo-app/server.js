'use strict';

// The thing a deployment spec actually deploys. It publishes evidence and makes
// no judgement: the control plane holds the criterion and does the arithmetic,
// because an app that graded its own acceptance could report whatever it liked.

const http = require('http');

const PORT = process.env.PORT || 3000;
const NAME = process.env.APP_NAME || 'hello-world';

// so a run can be made to fail acceptance on demand
const FAIL_RATE = Number(process.env.FAIL_RATE || 0);

const counts = { 200: 0, 500: 0 };

http.createServer(function (req, res) {
    if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        return res.end(
            '# HELP http_requests_total Requests handled, by status.\n'
            + '# TYPE http_requests_total counter\n'
            + 'http_requests_total{status="200"} ' + counts[200] + '\n'
            + 'http_requests_total{status="500"} ' + counts[500] + '\n');
    }
    if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"status":"ok"}');
    }
    const failing = Math.random() < FAIL_RATE;
    const status = failing ? 500 : 200;
    counts[status] += 1;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: NAME, status: failing ? 'error' : 'ok' }));
}).listen(PORT, function () {
    console.log(NAME + ' listening on ' + PORT + ' (fail rate ' + FAIL_RATE + ')');
});
