import * as ErrorLens from "@errorlenshq/node";
ErrorLens.init({});
setTimeout(() => { throw new RangeError("boom uncaught"); }, 10);
