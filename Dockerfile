# The Activity Simulator as it runs in AWS (infra/): the same server as `npm run simulator`,
# in cloud mode. It is built by CodeBuild (infra/), never on the operator's machine.
#
# The COPY list is the server's whole import closure plus the files it serves: src/ (the
# generator, the contract copies and src/simulator/), simulator/ (the page), scenarios/
# and business-docs/. Nothing of LearnLoop is in the image, and no git: the cloud
# simulator never publishes (SIMULATOR_PUBLISH=off).
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
    SIMULATOR_DATA_ROOT=/data
# the image's own unprivileged user (uid 1000), the owner of the EFS access point
USER node
EXPOSE 8790
CMD ["node", "src/simulator/server.js"]
