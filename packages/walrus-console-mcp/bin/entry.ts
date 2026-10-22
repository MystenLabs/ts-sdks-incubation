#!/usr/bin/env node
import { assertSupportedNode } from "../src/nodeVersion";

assertSupportedNode();
await import("./console-mcp.js");
