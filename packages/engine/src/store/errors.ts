export class StoreError extends Error {
  constructor(message: string) {
    super(message);
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

export class EmptyStoreError extends StoreError {
  constructor() {
    super(
      "nothing to export: the store has no head sha or manifest yet; run `repowiki build` first",
    );
  }
}
