const loader = require('./loader.js');

const queryDefaults = loader.queryDefaults();
const solnA = require('./solution-a.js');
const solnB = require('./solution-b.js');

function main() {
    return {
        solnA: solnA.main(queryDefaults.tenant_id, queryDefaults.environment),
        solnB: solnB.main(queryDefaults.tenant_id, queryDefaults.environment, queryDefaults.application_name)

    };
}

const result = main();
console.log(JSON.stringify(result, null, 2));
