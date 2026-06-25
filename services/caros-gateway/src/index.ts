import { config } from "./config";
import { initTelemetry } from "./usage";
import { createServer } from "./server";

initTelemetry();

const app = createServer();
app.listen(config.port, () => {
  console.log(
    `[caros-gateway] listening on :${config.port} — AOAI=${config.aoai.endpoint} ` +
      `auth=${config.aoai.authMode} mini=${config.aoai.deployments.mini} nano=${config.aoai.deployments.nano}`,
  );
});
