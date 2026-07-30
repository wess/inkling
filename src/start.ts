// Production entry. One process, one port — src/server.ts serves the API, the
// delivery surface, and the admin from the same origin, so there is nothing here
// to coordinate. `bun --hot src/server.ts` is the development equivalent.
export {}

process.env.NODE_ENV ??= "production"

// Imported dynamically so NODE_ENV is set before src/server.ts reads config —
// a static import would be hoisted above the assignment.
await import("./server.ts")
