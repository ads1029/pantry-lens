// Shared by the browser catalog and local server; no Node-only dependencies.
export class RecipeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
