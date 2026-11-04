export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

export class UserQuit extends Error {
  constructor(message = '已結束') {
    super(message);
    this.name = 'UserQuit';
    this.exitCode = 0;
  }
}
