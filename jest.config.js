module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 120000,
  // Several suites synthesize the stack and bundle the Lambda. Two workers keep that from
  // starving the machine; more made a worker miss jest's shutdown deadline.
  maxWorkers: 2,
};
