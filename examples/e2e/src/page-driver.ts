// Call the page API from Node. Each response is checked with its zod schema.

import type { Page } from "playwright-core";
import type { z } from "zod";
import { pageResponseSchema, type PageError, type PageRequest } from "./page-api.ts";

// An error that the page reported. code and serviceCode are stable codes.
export class PageCallError extends Error {
  override readonly name = "PageCallError";
  readonly page: PageError;

  constructor(op: string, page: PageError) {
    super(`${op}: ${page.code ?? page.name}${page.serviceCode === null ? "" : ` (${page.serviceCode})`}: ${page.message}`);
    this.page = page;
  }
}

export type PageCall = <S extends z.ZodType>(request: PageRequest, schema: S) => Promise<z.output<S>>;

export function pageCaller(page: Page): PageCall {
  return async (request, schema) => {
    const text = await page.evaluate(`window.anonE2E(${JSON.stringify(JSON.stringify(request))})`);
    const response = pageResponseSchema.parse(JSON.parse(String(text)));
    switch (response.ok) {
      case true:
        return schema.parse(response.value);
      case false:
        throw new PageCallError(request.op, response.error);
    }
  };
}

// Call the page and return the page error code (serviceCode, else code) of an expected error.
export async function expectPageError(call: PageCall, request: PageRequest, schema: z.ZodType): Promise<string> {
  try {
    await call(request, schema);
  } catch (error) {
    if (error instanceof PageCallError) return error.page.serviceCode ?? error.page.code ?? error.page.name;
    throw error;
  }
  return "no_error";
}
