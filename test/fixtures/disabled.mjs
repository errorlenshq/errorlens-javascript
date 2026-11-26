import http from "node:http";
import * as ErrorLens from "@errorlenshq/node";
const before = http.request;
ErrorLens.init({});
console.log(JSON.stringify({ enabled: ErrorLens.isEnabled(), patched: http.request !== before, id: ErrorLens.captureMessage("x") ?? null }));
