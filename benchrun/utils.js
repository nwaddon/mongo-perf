function prepOp(collection, op) {

    function fixString( str ) {
        if (str == "#B_COLL") {
            return collection.getName();
        }
        if (str == "#B_NS") {
            return collection.getFullName();
        }
        if (str == "#B_DB") {
            return collection.getDB().getName();
        }
        throw "unknown expansion " + str;
    }

    function recurse(doc) {
        for (var key in doc) {
            var val = doc[key];
            if (typeof(val) == "string" && val.indexOf("#B_") == 0) {
                doc[key] = fixString(val);
            }
            else if (typeof(val) == "object") {
                recurse(val);
            }
        }
    }
    recurse(op);

    if (!op.ns) {
        if (op.command)
            op.ns = collection.getDB().getName();
        else
            op.ns = collection.getFullName();
    }

    return op;
}

function formatRunDate(now) {
    function pad(dateComponent) {
        dateComponent = "" + dateComponent;
        while (dateComponent.length < 2) {
            dateComponent = "0" + dateComponent;
        }
        return dateComponent;
    }

    return (1900 + now.getYear() + "-" +
            pad(now.getMonth() + 1) + "-" +
            pad(now.getDate()));
}

function runTest(test, thread, multidb) {
    var collections = [];

    for (var i = 0; i < multidb; i++) {
        var sibling_db = db.getSiblingDB('test' + i);
        var coll = sibling_db.foo;
        collections.push(coll);
        coll.drop();
    }

    var new_ops = [];

    test.ops.forEach(function(z) {
        // For loop is INSIDE for-each loop so that duplicated instructions are adjacent.
        // (& should not be factored out for that reason.)
        for (var i = 0; i < multidb; i++) {
            new_ops.push(prepOp(collections[i], z));
        }
    });

    if ("pre" in test) {
        for (var i = 0; i < multidb; i++) {
            test.pre(collections[i]);
        }
    }

    var benchArgs = { ops:      new_ops,
                      seconds:  5,
                      host:     db.getMongo().host,
                      parallel: thread };

    var result = benchRun(benchArgs);
    var total =
        result["insert"] +
        result["query"] +
        result["update"] +
        result["delete"] +
        result["getmore"] +
        result["command"];

    print("\t" + thread + "\t" + total);

    if ("post" in test) {
        for (var i = 0; i < multidb; i++) {
            test.post(collections[i]);
        }
    }

    return { ops_per_sec: total };
}



function runTests(threadCounts, multidb, reportLabel) {
    var testResults = {};
    // The following are only used when reportLabel is not None.
    var resultsCollection = db.getSiblingDB("bench_results").raw;
    var myId = 0;

    // Set up the reporting database and the object that will hold these tests' info.
    if (reportLabel) {
        resultsCollection.ensureIndex({ label: 1 }, { unique: true });

        var now = new Date();
        myId = new ObjectId();
        var bi = db.runCommand("buildInfo");
        var basicFields = {
            commit:     bi.gitVersion,
            label:      reportLabel,
            platform:   bi.sysInfo.split(" ")[0],
            run_date:   formatRunDate(now),
            run_time:   now,
            version:    bi.version
        };

        var oldDoc = resultsCollection.findOne({ label: reportLabel });
        if (oldDoc) {
            myId = oldDoc._id;
            resultsCollection.update({ _id: myId }, { $set: basicFields });
        } else {
            basicFields._id = myId;
            resultsCollection.insert(basicFields);
        }
    }

    print("@@@START@@@");

    // Run all tests in the test file.
    for (var i = 0; i < tests.length; i++) {
        var test = tests[i];
        print(test.name);

        var threadResults = {};
        for (var t = 0; t < threadCounts.length; t++) {
            var threadCount = threadCounts[t];
            threadResults[threadCount] = runTest(test, threadCount, multidb);
        }
        testResults[test] = threadResults;

        if (reportLabel) {
            if (resultsCollection.findOne({ _id: myId, "singledb.name": test.name })) {
                resultsCollection.update({ _id: myId, "singledb.name": test.name },
                                         { $set: { "singledb.$.results": threadResults } });
            } else {
                resultsCollection.update({ _id: myId },
                                         { $push: { "singledb": { name: test.name,
                                                                  results: threadResults } } });
            }
        }
    }

    // End delimiter for the useful output to be displayed.
    print("@@@END@@@");

    return testResults;
}
