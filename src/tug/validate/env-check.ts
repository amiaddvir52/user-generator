import { TugError } from "../common/errors.js";
import {
  isSupportedEnvironment,
  SUPPORTED_ENVIRONMENTS
} from "../../shared/supported-environments.js";

export const ensureRequiredEnvironment = ({
  environment
}: {
  environment?: string;
}) => {
  const selectedEnvironment = environment?.trim();
  if (!selectedEnvironment) {
    throw new TugError(
      "ENV_INCOMPLETE",
      "Environment is required for execution. Pass --environment, set TUG_ENVIRONMENT, or save it in onboarding."
    );
  }

  if (!isSupportedEnvironment(selectedEnvironment)) {
    throw new TugError(
      "ENV_INCOMPLETE",
      `Environment ${selectedEnvironment} is not supported. Supported environments: ${SUPPORTED_ENVIRONMENTS.join(", ")}.`
    );
  }
};
