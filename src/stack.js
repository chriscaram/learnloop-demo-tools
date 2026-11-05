// Reads the deployed LearnLoop stack's outputs (bucket names, distribution, log prefix, secret names).
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const STACK_NAME = process.env.LEARNLOOP_STACK ?? 'LearnLoopProd';

export async function readStackOutputs(stackName = STACK_NAME) {
  const client = new CloudFormationClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const out = await client.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries((out.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
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
