export class StoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UnsupportedSchemaError extends StoreError {
  constructor(found: number, supported: number) {
    super(
      `store schema version ${found} is newer than this RepoWiki supports (${supported}); upgrade RepoWiki`,
    );
  }
}

export class DuplicateManifestError extends StoreError {
  constructor(sha: string) {
    super(`a manifest for ${sha} is already stored`);
  }
}

export class StaleParentError extends StoreError {
  constructor(featureId: string, current: string | null, parent: string | null) {
    super(
      `revision for ${featureId} names parent ${parent ?? "none"}, but the current revision is ${current ?? "none"}`,
    );
  }
}

export class DroppedFeatureError extends StoreError {
  constructor(sha: string, missing: string[]) {
    super(
      `manifest ${sha} drops feature ${missing.join(", ")}; feature ids are permanent, so a merged, split, or retired feature must stay in the manifest with a redirect, disambiguation, or retired status`,
    );
  }
}

export class UnknownFeatureError extends StoreError {
  constructor(featureId: string) {
    super(
      `feature ${featureId} is not in the latest stored manifest; store the manifest first with putManifest`,
    );
  }
}

export class EmptyStoreError extends StoreError {
  constructor() {
    super(
      "nothing to export: the store has no head sha or manifest yet; run `repowiki build` first",
    );
  }
}

export class DuplicateRevisionError extends StoreError {
  constructor(id: string) {
    super(`a revision with id ${id} is already stored; revision ids are never reused`);
  }
}

export class UnknownManifestError extends StoreError {
  constructor(sha: string) {
    super(`no manifest is stored for ${sha}`);
  }
}
