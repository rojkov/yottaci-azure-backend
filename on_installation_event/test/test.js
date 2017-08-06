const assert = require("assert");
const sinon = require("sinon");
const on_installation_event = require("../index");

let common = require("../../lib/common");

const queueitem = {
    gh: {
	action: "created", // alternatively this can be "deleted"
	installation: {
	    id: 45679,
	    account: {
		login: "rojkov"
	    }
	}
    }
};

describe("on_installation_event handler", function() {
    var fake_get_azure_token;
    var fake_create_resource_group;
    var fake_request;

    let ctx = {
	log: console.log,
	done: function() {}
    };
    ctx.log.error = function(err) { console.log("ERROR:", err); };

    before(function() {
	process.env["YottaCIDataStorage"] = "AccountName=fakeaccount;AccountKey=njnjnjfnjinji";
    });

    beforeEach(function() {
	fake_get_azure_token = sinon.stub(common, "get_azure_token");
	fake_get_azure_token.onCall(0).resolves("fake_token");
	fake_create_resource_group = sinon.stub(common, "create_resource_group");
	fake_get_http_response = sinon.stub(common, "get_http_response");
	fake_get_http_response.resolves({
	    headers: {},
	    statusCode: 201,
	    statusMessage: "OK",
	    body: ""
	});
    });

    afterEach(function() {
	common.get_azure_token.restore();
	common.create_resource_group.restore();
	common.request.restore();
	common.get_http_response.restore();
	assert(fake_create_resource_group.calledWith("github-45679", "fake_token"));
    });

    it("should work", function(done) {
	ctx.done = done;
	fake_request = sinon.stub(common, "request");
	fake_request.onCall(0).resolves(JSON.stringify({nameAvailable: true}));

	on_installation_event(ctx, queueitem);
    });

    it("should work 2", function(done) {
	ctx.done = done;
	fake_request = sinon.stub(common, "request");
	fake_request.onCall(0).resolves(JSON.stringify({nameAvailable: false}));
	fake_request.onCall(1).resolves(JSON.stringify({nameAvailable: false}));
	fake_request.onCall(2).resolves(JSON.stringify({nameAvailable: true}));

	on_installation_event(ctx, queueitem);
    });

    it("should fail", function(done) {
	ctx.done = done;
	fake_request = sinon.stub(common, "request");
	fake_request.onCall(0).resolves(JSON.stringify({nameAvailable: false}));
	fake_request.onCall(1).resolves(JSON.stringify({nameAvailable: false}));
	fake_request.onCall(2).resolves(JSON.stringify({nameAvailable: false}));
	fake_request.onCall(3).resolves(JSON.stringify({nameAvailable: false}));
	fake_request.onCall(4).resolves(JSON.stringify({nameAvailable: false}));
	fake_request.onCall(5).resolves(JSON.stringify({nameAvailable: false}));
	fake_request.onCall(6).resolves(JSON.stringify({nameAvailable: false}));
	fake_request.onCall(7).resolves(JSON.stringify({nameAvailable: true}));

	on_installation_event(ctx, queueitem);
    });
});
