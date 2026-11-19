# The Activity Simulator as it runs in AWS (infra/): the same server as `npm run simulator`,
# in cloud mode. It is built by CodeBuild (infra/), never on the operator's machine.
#
# The COPY list is the server's whole import closure plus the files it serves: src/ (the
# generator, the contract copies and src/simulator/), simulator/ (the page), scenarios/
# and business-docs/. Nothing of LearnLoop is in the image, and no git: the cloud
# simulator never publishes (SIMULATOR_PUBLISH=off).
#
# The records (state/: what is loaded on each target) and the seed folder live on EFS
# (/data, survives a task replacement); the generated log files (out/, ~8,700 files, a
# cache of one generation) live on the task's own disk (/tmp/simulator): written to EFS one
# by one they took about 90 s of a 105 s stage-0 generation, on local disk under 2 s.
FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY simulator ./simulator
COPY scenarios ./scenarios
COPY business-docs ./business-docs
ENV NODE_ENV=production \
    SIMULATOR_BIND=0.0.0.0 \
    SIMULATOR_PUBLISH=off \
    SIMULATOR_DATA_ROOT=/data \
    SIMULATOR_SCRATCH_ROOT=/tmp/simulator
# the image's own unprivileged user (uid 1000), the owner of the EFS access point
USER node
EXPOSE 8790
CMD ["node", "src/simulator/server.js"]
