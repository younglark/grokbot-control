/** Private, single-user archive. Never follows symlinks (including ancestors).
 * Not a security boundary against another process running as the same OS user.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { GbcError } from "../errors.js";
export function denied(message) {
    throw new GbcError("denied", message);
}
export function hash(s) {
    return createHash("sha256").update(s).digest("hex");
}
export function component(id) {
    if (!id || Buffer.byteLength(id) > 120 || /[\x00-\x1f]/.test(id))
        throw new GbcError("invalid_argument", "ID must be nonempty, <=120 bytes, without control characters");
    return "id-" + Buffer.from(id).toString("base64url");
}
/** Default (unlisted) session has empty session_id on the wire (App omits it). */
export function sessionComponent(id) {
    return id === "" ? "default" : component(id);
}
export class Archive {
    root;
    constructor(root, create = false) {
        if (!root || !path.isAbsolute(root))
            throw new GbcError("invalid_argument", "sync root must be an absolute path");
        this.root = path.resolve(root);
        if (this.root === path.parse(this.root).root)
            denied("filesystem root is not an archive");
        let cur = path.parse(this.root).root;
        for (const part of this.root.slice(cur.length).split(path.sep)) {
            cur = path.join(cur, part);
            if (!fs.existsSync(cur)) {
                // lstat also catches dangling symlinks, unlike existsSync.
                try {
                    fs.lstatSync(cur);
                    denied("symlink in sync root");
                }
                catch (e) {
                    if (e.code !== "ENOENT")
                        throw e;
                }
                if (!create)
                    throw new GbcError("not_found", "archive does not exist");
                fs.mkdirSync(cur, { mode: 0o700 });
                this.syncDir(path.dirname(cur));
            }
            const s = fs.lstatSync(cur);
            if (!s.isDirectory() || s.isSymbolicLink())
                denied("sync root ancestor must be a real directory");
            if ((process.getuid && s.uid !== process.getuid() && s.uid !== 0) ||
                (s.mode & 0o022 && !(s.mode & 0o1000)))
                denied("sync root ancestors must be trusted and not group/world writable (sticky temporary directories excepted)");
        }
        this.directory(this.root);
    }
    directory(p) {
        const s = fs.lstatSync(p);
        if (!s.isDirectory() ||
            s.isSymbolicLink() ||
            (process.getuid && s.uid !== process.getuid()) ||
            s.mode & 0o077)
            denied("archive directories must be owned by current user and mode 0700");
    }
    file(rel, parents = false) {
        if (!rel ||
            path.isAbsolute(rel) ||
            rel.split(/[\\/]/).some((p) => !p || p === "." || p === ".."))
            denied("unsafe archive path");
        this.directory(this.root);
        const parts = rel.split("/");
        let cur = this.root;
        for (const part of parts.slice(0, -1)) {
            cur = path.join(cur, part);
            try {
                this.directory(cur);
            }
            catch (e) {
                if (e.code !== "ENOENT" || !parents)
                    throw e;
                fs.mkdirSync(cur, { mode: 0o700 });
                this.syncDir(path.dirname(cur));
                this.directory(cur);
            }
        }
        const p = path.join(cur, parts.at(-1));
        try {
            const s = fs.lstatSync(p);
            if (!s.isFile() ||
                s.isSymbolicLink() ||
                s.nlink !== 1 ||
                (process.getuid && s.uid !== process.getuid()) ||
                s.mode & 0o077)
                denied("archive file must be private, regular and not linked");
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw e;
        }
        return p;
    }
    read(rel, maxBytes = 64 * 1024 * 1024) {
        let fd;
        try {
            fd = fs.openSync(this.file(rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const s = fs.fstatSync(fd);
            if (!s.isFile() || s.size > maxBytes)
                denied("archive file exceeds read bound or is not regular");
            return fs.readFileSync(fd, "utf8");
        }
        catch (e) {
            if (e.code === "ENOENT")
                return undefined;
            throw e;
        }
        finally {
            if (fd !== undefined)
                fs.closeSync(fd);
        }
    }
    json(rel) {
        const s = this.read(rel);
        return s === undefined ? undefined : JSON.parse(s);
    }
    atomic(rel, text) {
        const target = this.file(rel, true), tempRel = ".sync/staging/" + randomUUID() + ".tmp";
        const tmp = this.file(tempRel, true);
        const fd = fs.openSync(tmp, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o600);
        try {
            fs.writeFileSync(fd, text);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        // Re-check destination and ancestors immediately before rename.
        this.file(rel);
        fs.renameSync(tmp, target);
        this.syncDir(path.dirname(target));
        this.syncDir(path.dirname(tmp));
    }
    writeJson(rel, data) {
        this.atomic(rel, JSON.stringify(data, null, 2) + "\n");
    }
    syncDir(dir) {
        const fd = fs.openSync(dir, fs.constants.O_RDONLY |
            fs.constants.O_DIRECTORY |
            fs.constants.O_NOFOLLOW);
        try {
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
    }
    lock() {
        const p = this.file(".sync/lock", true);
        let fd;
        try {
            fd = fs.openSync(p, fs.constants.O_WRONLY |
                fs.constants.O_CREAT |
                fs.constants.O_EXCL |
                fs.constants.O_NOFOLLOW, 0o600);
        }
        catch (e) {
            if (e.code === "EEXIST")
                throw new GbcError("conflict", "archive locked; never auto-remove a stale lock; verify no writer then remove manually");
            throw e;
        }
        const token = randomUUID();
        try {
            fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid }));
            fs.fsyncSync(fd);
        }
        catch (e) {
            fs.closeSync(fd);
            throw e;
        }
        fs.closeSync(fd);
        this.syncDir(path.dirname(p));
        return () => {
            if (this.json(".sync/lock")?.token !== token)
                denied("lock ownership changed; refusing release");
            fs.unlinkSync(this.file(".sync/lock"));
            this.syncDir(path.dirname(p));
        };
    }
    stage() {
        const rel = ".sync/staging/" + randomUUID() + ".tmp";
        const tmp = this.file(rel, true);
        const fd = fs.openSync(tmp, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o600);
        let open = true, exists = true;
        const close = () => {
            if (open) {
                fs.closeSync(fd);
                open = false;
            }
        };
        return {
            write: (bytes) => {
                let off = 0;
                while (off < bytes.length)
                    off += fs.writeSync(fd, bytes, off, bytes.length - off);
            },
            commit: (target) => {
                const dest = this.file(target, true);
                fs.fsyncSync(fd);
                close();
                this.file(target);
                fs.renameSync(tmp, dest);
                exists = false;
                this.syncDir(path.dirname(dest));
                this.syncDir(path.dirname(tmp));
            },
            discard: () => {
                close();
                if (exists) {
                    fs.unlinkSync(tmp);
                    exists = false;
                    this.syncDir(path.dirname(tmp));
                }
            },
        };
    }
    /** Binary counterpart of atomic(); never follows symlinks. */
    atomicBytes(rel, data) {
        const target = this.file(rel, true), tempRel = ".sync/staging/" + randomUUID() + ".tmp";
        const tmp = this.file(tempRel, true);
        const fd = fs.openSync(tmp, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o600);
        try {
            fs.writeFileSync(fd, data);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        this.file(rel);
        fs.renameSync(tmp, target);
        this.syncDir(path.dirname(target));
        this.syncDir(path.dirname(tmp));
    }
}
