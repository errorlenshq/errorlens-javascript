const ErrorLens = require("@errorlenshq/node");
ErrorLens.init({});
ErrorLens.captureException(new TypeError("from commonjs"));
ErrorLens.flush(5000).then((ok) => console.log("flushed", ok));
