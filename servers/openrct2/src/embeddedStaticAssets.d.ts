export interface EmbeddedStaticFile {
    body: string;
    contentType: string;
}

export const embeddedStaticFiles: Record<string, EmbeddedStaticFile>;
