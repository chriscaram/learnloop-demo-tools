// Reads the deployed LearnLoop stack's outputs (bucket names, distribution, log prefix, secret names).
//
// Two deployments can be loaded, each its own CloudFormation stack with the same output
// keys and its own pseudonym salt secret: Production (LearnLoopProd, the default) and
// Staging (LearnLoopStaging, where the whole flow is run beforehand). Everything a load
// touches follows the target: outputs, salt, buckets and the loaded-state record.
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const TARGETS = Object.freeze({
  production: Object.freeze({ id: 'production', label: 'Production', stack: 'LearnLoopProd', publish: true }),
  staging: Object.freeze({ id: 'staging', label: 'Staging', stack: 'LearnLoopStaging', publish: false }),
});
export const DEFAULT_TARGET = 'production';
export const STACK_NAME = process.env.LEARNLOOP_STACK ?? TARGETS[DEFAULT_TARGET].stack;

/** The target a name refers to: a target id (production, staging) or its stack name. Throws otherwise. */
export function targetOf(name = DEFAULT_TARGET) {
  const t = TARGETS[name] ?? Object.values(TARGETS).find((x) => x.stack === name);
  if (!t) throw new Error(`unknown target '${name}': choose ${Object.values(TARGETS).map((x) => `${x.id} (${x.stack})`).join(' or ')}`);
  return t;
}

export class StackNotFoundError extends Error {}

/** CloudFormation's answer for a stack that does not exist, in words. */
export function isStackMissing(error) {
  return /does not exist/i.test(error?.message ?? '') || error?.name === 'StackNotFoundError';
}

export async function readStackOutputs(stackName = STACK_NAME, { region = process.env.AWS_REGION ?? 'us-east-1', client = null } = {}) {
  const cf = client ?? new CloudFormationClient({ region });
  let out;
  try {
    out = await cf.send(new DescribeStacksCommand({ StackName: stackName }));
  } catch (error) {
    if (isStackMissing(error)) {
      throw new StackNotFoundError(`the LearnLoop stack '${stackName}' was not found in ${region}: it is not deployed (yet) in this account and region. Deploy it first, or choose the other target.`);
    }
    throw error;
  }
  if (!out.Stacks?.length) throw new StackNotFoundError(`the LearnLoop stack '${stackName}' was not found in ${region}.`);
  return Object.fromEntries((out.Stacks[0].Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

/** Upload targets derived from the outputs; throws if any is missing. */
export function uploadTargets(outputs) {
  const required = ['StateBucketName', 'AppLogsBucketName', 'AccessLogsBucketName', 'CloudFrontLogPrefix',
    'DistributionId', 'DistributionDomainName', 'LogPseudonymSaltSecretName'];
  const missing = required.filter((k) => !outputs[k]);
  if (missing.length) throw new Error(`stack outputs missing: ${missing.join(', ')}`);
  return {
    stateBucket: outputs.StateBucketName,
    appLogsBucket: outputs.AppLogsBucketName,
    accessLogsBucket: outputs.AccessLogsBucketName,
    cloudfrontPrefix: outputs.CloudFrontLogPrefix,
    distributionId: outputs.DistributionId,
    distributionDomain: outputs.DistributionDomainName,
    saltSecret: outputs.LogPseudonymSaltSecretName,
  };
}

/** Every CloudFront log key must sit directly under the distribution's logging prefix. */
export function assertCloudfrontKeys(keys, prefix, distributionId) {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${distributionId}\\.\\d{4}-\\d{2}-\\d{2}-\\d{2}\\.[A-Z0-9]+\\.gz$`);
  const bad = [...keys].filter((k) => !pattern.test(k));
  if (bad.length) throw new Error(`CloudFront log keys outside ${prefix}: ${bad.slice(0, 3).join(', ')}`);
}
