import * as ErrorLens from "@errorlenshq/node";
ErrorLens.init({});
Promise.reject(new Error("boom rejected"));
setTimeout(() => console.log("still alive"), 3000);
