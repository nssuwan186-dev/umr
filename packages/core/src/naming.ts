import { createHash } from "node:crypto";
import path from "node:path";

import type { JsonValue, ModelManifestMember } from "./types";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function deriveModelRef(
  contentDigest: string,
  isTaken: (ref: string) => boolean,
): string {
  let length = 16;
  while (length <= contentDigest.length) {
    const ref = `m_${contentDigest.slice(0, length)}`;
    if (!isTaken(ref)) {
      return ref;
    }

    length += 2;
  }

  return `m_${contentDigest}`;
}

export function deriveModelName(
  entryRelPath: string,
  metadata: Record<string, JsonValue>,
): string {
  const metadataName =
    typeof metadata["general.name"] === "string"
      ? metadata["general.name"]
      : undefined;
  const basename = path.basename(entryRelPath, path.extname(entryRelPath));
  const base = metadataName ?? basename;
  const slug = slugify(base) || "model";
  const quantMatch = basename.match(/q\d(?:[_-][a-z0-9]+)+/i);
  if (quantMatch) {
    const quantSlug = slugify(quantMatch[0]);
    if (!slug.includes(quantSlug)) {
      return `${slug}-${quantSlug}`;
    }
  }

  return slug;
}

export function reserveUniqueModelName(
  baseName: string,
  isTaken: (name: string) => boolean,
): string {
  if (!isTaken(baseName)) {
    return baseName;
  }

  let suffix = 2;
  while (true) {
    const candidate = `${baseName}-${suffix}`;
    if (!isTaken(candidate)) {
      return candidate;
    }

    suffix += 1;
  }
}

export function deriveOllamaName(modelName: string, ref: string): string {
  const sanitized = slugify(modelName) || "model";
  return `vmr-${sanitized}-${ref.slice(2, 10)}`;
}

export function deriveContentDigest(manifest: ModelManifestMember[]): string {
  const canonical = [...manifest]
    .sort((left, right) => left.relPath.localeCompare(right.relPath))
    .map((member) => `${member.relPath}\t${member.sha256}\t${member.sizeBytes}`)
    .join("\n");

  return createHash("sha256").update(canonical).digest("hex");
}
