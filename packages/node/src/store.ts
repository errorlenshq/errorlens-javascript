import { AsyncLocalStorage } from "node:async_hooks";
import { Scope, type ScopeStore } from "@errorlenshq/core";

interface Scopes { isolation: Scope; current: Scope }

/** Scopes per async context: each request or task sees only its own data. */
export class AsyncScopeStore implements ScopeStore {
  private als = new AsyncLocalStorage<Scopes>();
  private root: Scopes = { isolation: new Scope(), current: new Scope() };

  private get(): Scopes { return this.als.getStore() || this.root; }
  isolation(): Scope { return this.get().isolation; }
  current(): Scope { return this.get().current; }

  withIsolation<T>(fn: () => T, freshBreadcrumbs = false): T {
    const parent = this.get();
    const isolation = parent.isolation.clone();
    if (freshBreadcrumbs) isolation.clearBreadcrumbs();
    return this.als.run({ isolation, current: parent.current.clone() }, fn);
  }

  withCurrent<T>(scope: Scope, fn: () => T): T {
    return this.als.run({ isolation: this.get().isolation, current: scope }, fn);
  }
}
