import {test} from "node:test";
import {strict as assert} from "node:assert";
import {submitStandalone} from "../src/standalone-dispatch.mjs";
test("standalone dispatch denies missing token", async () => {
 const response=await submitStandalone(new Request("https://example.com", {method:"POST",body:JSON.stringify({instructions:"test"})}),{});
 assert.equal(response.status,401);
});
test("standalone dispatch validates instructions before DB access", async () => {
 const response=await submitStandalone(new Request("https://example.com", {method:"POST",headers:{authorization:"Bearer secret"},body:JSON.stringify({instructions:""})}),{STANDALONE_DISPATCH_TOKEN:"secret"});
 assert.equal(response.status,400);
});
