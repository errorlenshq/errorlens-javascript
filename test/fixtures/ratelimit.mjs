import * as ErrorLens from "@errorlenshq/node";
ErrorLens.init({});
ErrorLens.captureMessage("first");
await ErrorLens.flush(5000);
for (let i = 0; i < 5; i++) ErrorLens.captureMessage(`dropped ${i}`);
await ErrorLens.flush(5000);
console.log(JSON.stringify({ dropped: ErrorLens.getClient().dropped }));
