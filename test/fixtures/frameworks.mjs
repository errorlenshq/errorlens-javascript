// Express, Fastify, Koa and Hapi: route-named transactions and reported handler errors.
import express from "express";
import Fastify from "fastify";
import Koa from "koa";
import Router from "@koa/router";
import Hapi from "@hapi/hapi";
import * as ErrorLens from "@errorlenshq/node";

ErrorLens.init({ tracesSampleRate: 1 });
const out = {};
const get = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`)).status;

// Express
const ex = express();
const router = express.Router();
router.get("/users/:id", (req, res) => res.json({ id: req.params.id }));
router.get("/fail/:id", () => { throw new Error("express route failed"); });
ex.use("/api", router);
ex.get("/teapot", (req, res, next) => { const e = new Error("short and stout"); e.status = 418; next(e); });
ErrorLens.setupExpressErrorHandler(ex);
const exServer = await new Promise((r) => { const s = ex.listen(0, "127.0.0.1", () => r(s)); });
out.express = [await get(exServer.address().port, "/api/users/9"), await get(exServer.address().port, "/api/fail/3"), await get(exServer.address().port, "/teapot")];

// Fastify
const fa = Fastify();
ErrorLens.setupFastifyErrorHandler(fa);
fa.get("/items/:id", async () => ({ ok: true }));
fa.get("/boom/:n", async () => { throw new Error("fastify route failed"); });
await fa.listen({ port: 0, host: "127.0.0.1" });
out.fastify = [await get(fa.server.address().port, "/items/5"), await get(fa.server.address().port, "/boom/7")];

// Koa
const koa = new Koa();
koa.silent = true;
const kr = new Router();
kr.get("/things/:id", (ctx) => { ctx.body = "ok"; });
kr.get("/explode/:n", () => { throw new Error("koa route failed"); });
koa.use(kr.routes());
ErrorLens.setupKoaErrorHandler(koa);
const koaServer = await new Promise((r) => { const s = koa.listen(0, "127.0.0.1", () => r(s)); });
out.koa = [await get(koaServer.address().port, "/things/1"), await get(koaServer.address().port, "/explode/x1")];

// Hapi
const hapi = Hapi.server({ port: 0, host: "127.0.0.1" });
hapi.route({ method: "GET", path: "/widgets/{id}", handler: () => "ok" });
hapi.route({ method: "GET", path: "/crash", handler: () => { throw new Error("hapi route failed"); } });
await ErrorLens.setupHapiErrorHandler(hapi);
await hapi.start();
out.hapi = [await get(hapi.info.port, "/widgets/2"), await get(hapi.info.port, "/crash")];

await ErrorLens.flush(5000);
console.log(JSON.stringify(out));
exServer.close(); await fa.close(); koaServer.close(); await hapi.stop();
