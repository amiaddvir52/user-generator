import type {
  ApiError,
  ConfigResponse,
  RunHistoryResponse,
  UserGenerationError,
  UserGenerationResponse
} from "../../shared/contracts.js";
import type { UserGenerationRequest } from "./types.js";

export const fetchConfig = async (): Promise<ConfigResponse> => {
  const response = await fetch("/api/config");

  if (!response.ok) {
    throw new Error("Unable to load User Generator configuration.");
  }

  return response.json();
};

export const fetchRunHistory = async (): Promise<RunHistoryResponse> => {
  const response = await fetch("/api/run-history");

  if (!response.ok) {
    throw new Error("Unable to load run history.");
  }

  return response.json();
};

export const postJson = async <TResponse, TBody extends Record<string, unknown>>(
  endpoint: string,
  body: TBody
): Promise<TResponse> => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = (await response.json()) as TResponse | ApiError;

  if (!response.ok) {
    throw new Error((payload as ApiError).message);
  }

  return payload as TResponse;
};

export class UserGenerationApiError extends Error {
  readonly status: number;
  readonly payload: UserGenerationError;

  constructor(status: number, payload: UserGenerationError) {
    super(payload.message);
    this.name = "UserGenerationApiError";
    this.status = status;
    this.payload = payload;
  }
}

export const postUserGeneration = async (
  body: UserGenerationRequest
): Promise<UserGenerationResponse> => {
  const response = await fetch("/api/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = (await response.json()) as UserGenerationResponse | UserGenerationError;

  if (!response.ok) {
    throw new UserGenerationApiError(response.status, payload as UserGenerationError);
  }

  return payload as UserGenerationResponse;
};
