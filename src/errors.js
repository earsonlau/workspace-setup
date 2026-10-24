export class SetupError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "SetupError";
  }
}
