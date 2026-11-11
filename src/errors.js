export class HttpError extends Error {
  constructor(status, message, extra = undefined) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export class PayPalError extends Error {
  constructor(message, status, details = {}, debugId = null) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.details = details;
    this.debugId = debugId;
  }
}
