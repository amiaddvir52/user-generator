import { createTwoFilesPatch } from "diff";

export const createUnifiedDiff = ({
  originalText,
  transformedText,
  originalLabel,
  transformedLabel
}: {
  originalText: string;
  transformedText: string;
  originalLabel: string;
  transformedLabel: string;
}) =>
  createTwoFilesPatch(
    originalLabel,
    transformedLabel,
    originalText,
    transformedText,
    "",
    "",
    {
      context: 3
    }
  );

