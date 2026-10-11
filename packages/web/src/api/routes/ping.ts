import { base } from "../middleware/errors";

export const ping = base.handler(() => ({ message: `Pong! ${Date.now()}` }));
