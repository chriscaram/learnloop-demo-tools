// cdk app: one stack, TelemetryActivitySimulator. Deploy it with `npm run cloud -- deploy`
// from the repository root (scripts/cloud.mjs), which supplies the two context values:
//   authHash   hex SHA-256 of the expected Basic Authorization header
//   learnloop  JSON: [{ stack, buckets: [state, app logs, access logs], saltSecret }] per deployed LearnLoop stack
import * as cdk from 'aws-cdk-lib';
import { SimulatorStack } from '../lib/simulator-stack.mjs';

const app = new cdk.App();
const learnloopRaw = app.node.tryGetContext('learnloop');
const learnloop = typeof learnloopRaw === 'string' ? JSON.parse(learnloopRaw) : learnloopRaw;
// tags of their own: the Governance Agent scans the account by LearnLoop's application tag
cdk.Tags.of(app).add('Application', 'telemetry-activity-simulator');
cdk.Tags.of(app).add('Purpose', 'demo-presenter-simulator');
new SimulatorStack(app, 'TelemetryActivitySimulator', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  description: 'Telemetry Activity Simulator for the demo presenter',
  authHash: app.node.tryGetContext('authHash'),
  learnloop,
});
