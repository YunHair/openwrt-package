#!/bin/sh

UPDATE_DIR="/tmp/gately_update"
RUN_DIR="$UPDATE_DIR/.run_$$"
trap 'rm -rf "$RUN_DIR"' EXIT
STATUS_FILE="$UPDATE_DIR/status"
LOG_FILE="$UPDATE_DIR/log"
RELEASES_FILE="$UPDATE_DIR/releases.json"
AUTO_LOG="$UPDATE_DIR/autoupdate.log"

PROGRESS_FILE="$UPDATE_DIR/progress"
CHECKSUMS_FILE="$UPDATE_DIR/checksums.txt"

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$msg" >&2
    [ -n "$LOG_TO_FILE" ] && echo "$msg" >> "$LOG_TO_FILE"
}

# Gately 仅在 GitHub 发布。为避免 GitHub REST API 未认证限流（60 次/小时），
# 版本列表走 git smart-http 的 info/refs（纯 HTTP，不走 API，不限流），
# 下载地址按发布命名规律直接构造。
REPO_URL="https://github.com/wangwanjie/gately"

# 可选 GitHub 加速镜像前缀（如 https://ghfast.top/）。
# 直连 github.com 超时（curl rc=28）时在「下载与更新」页填写；留空则直连。
GH_MIRROR=$(uci -q get gately.gately.github_mirror 2>/dev/null)
case "$GH_MIRROR" in
    ""|*/) ;;
    *) GH_MIRROR="$GH_MIRROR/" ;;
esac

gh_url() {
    local u="$1"
    if [ -n "$GH_MIRROR" ]; then
        printf '%s%s' "$GH_MIRROR" "$u"
    else
        printf '%s' "$u"
    fi
}

INFO_REFS=$(gh_url "$REPO_URL/info/refs?service=git-upload-pack")
DOWNLOAD_BASE=$(gh_url "$REPO_URL/releases/download")

init_dir() {
    [ -d "$UPDATE_DIR" ] || mkdir -p "$UPDATE_DIR"
    mkdir -p "$RUN_DIR"
}

tag_to_ver() { echo "$1" | sed 's/^v//'; }

uci_get() {
    local v; v=$(uci -q get "gately.gately.$1" 2>/dev/null)
    echo "${v:-$2}"
}

write_status() {
    echo "$1" > "$STATUS_FILE"
}

die() {
    local code="$2" detail="${3:-$2}"
    log "ERROR: $detail"
    write_status "error:$code"
    exit 1
}

CURL_UA="Mozilla/5.0 (compatible; luci-app-gately)"

http_get() {
    local url="$1" out="$2" t="${3:-60}"
    curl -fsSL -A "$CURL_UA" --connect-timeout 10 --max-time "$t" -o "$out" "$url"
}

# 输出 body 到 stdout；把 curl 的错误合并捕获，失败时记到日志便于诊断
# （rc=6 DNS 失败、rc=7 连接被拒、rc=28 超时、rc=22 HTTP 错误）
http_get_var() {
    local url="$1" t="${2:-30}" out rc
    out=$(curl -fsSL -A "$CURL_UA" --connect-timeout 10 --max-time "$t" "$url" 2>&1)
    rc=$?
    if [ $rc -ne 0 ]; then
        log "curl rc=$rc url=$url: $(printf '%s' "$out" | tr '\n' ' ' | head -c 200)"
        return $rc
    fi
    printf '%s' "$out"
}

# Gately 为 Go 架构命名，文件名形如 gately_<tag>_linux_<arch>.tar.gz
detect_arch() {
    local a; a=$(uci -q get gately.gately.arch 2>/dev/null)
    [ -n "$a" ] && [ "$a" != "auto" ] && echo "$a" && return
    case "$(uname -m)" in
        x86_64)        echo "amd64" ;;
        aarch64|arm64) echo "arm64" ;;
        armv7*)        echo "arm" ;;
        armv8*)        echo "arm64" ;;
        riscv64)       echo "riscv64" ;;
        mips)          echo "mips" ;;
        mipsel|mipsle) echo "mipsle" ;;
        *)             echo "amd64" ;;
    esac
}

fmt_size() {
    local bytes="$1"
    if [ -z "$bytes" ] || [ "$bytes" -eq 0 ] 2>/dev/null; then
        echo "unknown"
        return
    fi
    awk -v b="$bytes" 'BEGIN{
        if(b>=1048576) printf "%.1fM", b/1048576
        else           printf "%.1fKB", b/1024
    }'
}

# 预发布后缀归一化：dev<alpha<beta<rc，输出 rank.num
pre_key() {
    local s="$1" word num rank
    word=$(printf '%s' "$s" | grep -oE '[a-zA-Z]+' | head -1)
    num=$(printf '%s' "$s" | grep -oE '[0-9]+' | head -1)
    num=${num:-0}
    case "$word" in
        dev)               rank=0 ;;
        alpha|a)           rank=1 ;;
        beta|b)            rank=2 ;;
        rc|c)              rank=3 ;;
        *)                 rank=0 ;;
    esac
    echo "${rank}.${num}"
}

# 语义化版本比较：返回 0 表示 $1 < $2
version_lt() {
    local a b
    a=$(echo "$1" | sed 's/^v//')
    b=$(echo "$2" | sed 's/^v//')
    [ "$a" = "$b" ] && return 1

    local ca cb pa pb
    ca="${a%%-*}"; [ "$ca" = "$a" ] && pa="" || pa="${a#*-}"
    cb="${b%%-*}"; [ "$cb" = "$b" ] && pb="" || pb="${b#*-}"

    # 比较数字核心（逐段，缺省补 0）
    local i n na nb va vb
    na=$(printf '%s' "$ca" | awk -F. '{print NF}')
    nb=$(printf '%s' "$cb" | awk -F. '{print NF}')
    n=$na; [ "$nb" -gt "$n" ] && n=$nb
    for i in $(seq 1 "$n"); do
        va=$(printf '%s' "$ca" | awk -F. -v i="$i" '{print $i}'); va=${va:-0}
        vb=$(printf '%s' "$cb" | awk -F. -v i="$i" '{print $i}'); vb=${vb:-0}
        [ "$va" -lt "$vb" ] && return 0
        [ "$va" -gt "$vb" ] && return 1
    done

    # 核心相同：正式版 > 预发布版
    if [ -z "$pa" ] && [ -n "$pb" ]; then return 1; fi
    if [ -n "$pa" ] && [ -z "$pb" ]; then return 0; fi
    [ -z "$pa" ] && [ -z "$pb" ] && return 1

    # 都为预发布：比较后缀
    local ka kb lo
    ka=$(pre_key "$pa"); kb=$(pre_key "$pb")
    [ "$ka" = "$kb" ] && return 1
    lo=$(printf '%s\n%s' "$ka" "$kb" | sort -V | head -1)
    [ "$lo" = "$ka" ]
}

get_installed_version() {
    uci -q get gately.gately.installed_version 2>/dev/null || echo ""
}

save_installed_version() {
    uci -q set gately.gately.installed_version="$1" 2>/dev/null
    uci -q commit gately 2>/dev/null
}

# 判断 tag 是否为预发布（去 v 后含 - 后缀，如 v0.6.0-rc1）
is_prerelease_tag() {
    local v; v=$(tag_to_ver "$1")
    case "$v" in
        *-*) return 0 ;;
        *)   return 1 ;;
    esac
}

# 从 info/refs 拉取全部 tag（每行一个，已去重、去掉 ^{}）
# 字符类需含 "-"，否则 v0.6.0-rc1 这类预发布 tag 会被截断成 v0.6.0。
fetch_tags() {
    local i tags
    for i in 1 2 3; do
        tags=$(http_get_var "$INFO_REFS" 30 \
            | grep -aoE 'refs/tags/v[0-9][0-9A-Za-z.-]*' \
            | sed 's#refs/tags/##' | sort -u)
        if [ -n "$tags" ]; then
            printf '%s\n' "$tags"
            return 0
        fi
        log "Tag list empty, retrying ($i/3)..."
        sleep 2
    done
    return 1
}

# 对 stdin 的 tag 行做降序排序（最新在前）。
# 关键：在弱性能路由器上不能用 O(n^2) 的 shell 逐版比较（会 fork 上千进程、
# 长时间卡在 checking）。这里用单个 awk 把每个版本转成「定长、可字典序排序」
# 的键，再交给单个 sort -r，全程只 fork 3 个进程，与版本数量无关。
sort_tags_desc() {
    awk '{
        v = $0; sub(/^v/, "", v);
        p = index(v, "-");
        if (p > 0) { core = substr(v, 1, p - 1); pre = substr(v, p + 1); }
        else       { core = v; pre = ""; }

        m = split(core, seg, ".");
        key = "";
        for (i = 1; i <= 4; i++) {
            x = (i <= m) ? (seg[i] + 0) : 0;
            key = key sprintf("%06d", x);
        }

        if (pre == "") {
            # 正式版：末位给 9，保证排在同核心的预发布版之前
            key = key "9";
        } else {
            w = pre; gsub(/[0-9].*/, "", w);
            n = pre; sub(/^[a-zA-Z]*/, "", n); if (n == "") n = 0;
            r = 0;
            if (w == "dev")                         r = 0;
            else if (w == "alpha" || w == "a")      r = 1;
            else if (w == "beta"  || w == "b")      r = 2;
            else if (w == "rc"    || w == "c")      r = 3;
            key = key sprintf("%d%06d", r, n + 0);
        }
        print key "\t" $0;
    }' | sort -r | cut -f2
}

# 构造某个 tag + arch 的文件名
file_for() {
    echo "gately_${1}_linux_${2}.tar.gz"
}

# 从已排序的 tags 文件构造 releases JSON（每个版本针对当前 arch 提供一个 tar.gz）
build_releases_from_tags() {
    local tags_file="$1" arch="$2" reltype="$3"
    local result="" tag fname url
    while IFS= read -r tag; do
        [ -z "$tag" ] && continue
        if is_prerelease_tag "$tag" && [ "$reltype" != "prerelease" ]; then
            continue
        fi
        fname=$(file_for "$tag" "$arch")
        url="${DOWNLOAD_BASE}/${tag}/${fname}"
        result="${result:+$result,}{\"tag\":\"$tag\",\"best\":\"$fname\",\"best_url\":\"$url\",\"files\":[{\"name\":\"$fname\",\"url\":\"$url\"}]}"
    done < "$tags_file"
    printf '[%s]\n' "$result"
}

check_releases_count() {
    local json="$1" count
    { [ -z "$json" ] || [ "$json" = "[]" ]; } && return 1
    count=$(printf '%s' "$json" | grep -o '"tag"' | wc -l | tr -d ' ')
    [ "$count" -gt 0 ] 2>/dev/null || return 1
    printf '%s' "$count"
}

extract_url_from_releases() {
    local esc
    esc=$(printf '%s' "$2" | sed 's/\./\\./g')
    grep -o "\"name\":\"${esc}\",\"url\":\"[^\"]*\"" "$1" \
        | grep -o '"url":"[^"]*"' | cut -d'"' -f4 | head -1
}

# Gately 提供标准 sha256sum 格式的 checksums.txt：<hash>  <filename>
fetch_checksums() {
    local tag="$1"
    rm -f "$CHECKSUMS_FILE"
    http_get "${DOWNLOAD_BASE}/${tag}/checksums.txt" "$CHECKSUMS_FILE" 30 \
        && [ -s "$CHECKSUMS_FILE" ] \
        && { log "Got checksums.txt for $tag"; return 0; }
    rm -f "$CHECKSUMS_FILE"
    log "WARN: checksums.txt not available, verification will be skipped"
    return 0
}

verify_sha256() {
    local file="$1" checksums="$2" fname expected actual
    [ -s "$checksums" ] || return 0
    fname="${file##*/}"
    expected=$(awk -v f="$fname" '$2==f{print $1; exit}' "$checksums")
    if [ -z "$expected" ]; then
        log "WARN: no checksum entry for $fname, verification skipped"
        return 0
    fi
    actual=$(sha256sum "$file" | awk '{print $1}')
    log "Expected sha256: $expected"
    log "Computed sha256: $actual"
    if [ "$expected" = "$actual" ]; then
        log "SHA256 verified OK"
        return 0
    fi
    log "SHA256 verification failed"
    return 1
}

do_download() {
    local releases_file="$1" tag="$2" filename="$3"
    local progress
    local url
    url=$(extract_url_from_releases "$releases_file" "$filename")
    [ -z "$url" ] && die "url_not_found" "No download URL found for $filename"

    init_dir
    echo 0 > "$PROGRESS_FILE"
    write_status "downloading:$tag"
    log "Downloading: $filename"
    log "URL: $url"

    local f="$UPDATE_DIR/$filename"

    local total_size
    total_size=$(curl -sIL --connect-timeout 15 "$url" 2>/dev/null \
        | grep -i content-length | tail -1 | awk '{print $2}' | tr -d '\r')

    if [ -n "$total_size" ] && [ "$total_size" -gt 0 ] 2>/dev/null; then
        log "Total size: $(fmt_size "$total_size")"
        (
            while true; do
                sleep 1
                [ -f "$f" ] || continue
                downloaded=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
                [ "${downloaded:-0}" -gt 0 ] 2>/dev/null || continue
                pct=$(awk "BEGIN{printf \"%d\", $downloaded*100/$total_size}")
                echo "$pct" > "$PROGRESS_FILE"
                [ "$pct" -ge 100 ] && break
            done
        ) &
        local progress_pid=$!

        http_get "$url" "$f" 300
        local ret=$?
        kill "$progress_pid" 2>/dev/null
        wait "$progress_pid" 2>/dev/null
    else
        log "Total size: unknown"
        http_get "$url" "$f" 300
        local ret=$?
    fi
    echo 100 > "$PROGRESS_FILE"

    [ $ret -ne 0 ] && die "download_failed" "Download failed: $url"
    [ -s "$f" ]    || die "download_empty" "Downloaded file is empty"
    log "Download complete: $(fmt_size "$(wc -c < "$f" | tr -d ' ')")"

    fetch_checksums "$tag"
    verify_sha256 "$f" "$CHECKSUMS_FILE" \
        || die "checksum_failed" "SHA256 verification failed, file may be corrupted"
    echo "$f"
}

cmd_check() {
    local reltype="${1:-$(uci_get release_type stable)}"
    local arch="${2:-$(detect_arch)}"
    [ "$arch" = "auto" ] && arch=$(detect_arch)

    init_dir
    write_status "checking"
    log "Checking upstream versions (channel=$reltype arch=$arch)"
    if [ -n "$GH_MIRROR" ]; then
        log "Mirror enabled: $GH_MIRROR"
    else
        log "Mirror: none (direct to github.com)"
    fi

    # 只拉取一次 info/refs，直接排序落盘。
    # fetch_tags 失败时自身会把 curl rc/原因写进日志（rc=6 DNS、7 连接、28 超时）。
    local tags_file="$RUN_DIR/tags.sorted"
    local raw_tags
    raw_tags=$(fetch_tags) || raw_tags=""
    if [ -n "$raw_tags" ]; then
        printf '%s\n' "$raw_tags" | sort_tags_desc > "$tags_file"
    fi

    if [ ! -s "$tags_file" ] || ! grep -aq . "$tags_file"; then
        die "check_failed" "Cannot reach github.com to fetch versions. Check WAN/DNS, or configure a proxy. Details in the log."
    fi

    local releases_json
    releases_json=$(build_releases_from_tags "$tags_file" "$arch" "$reltype")

    local count; count=$(check_releases_count "$releases_json") \
        || die "no_releases" "No gately versions found"
    printf '%s\n' "$releases_json" > "$RELEASES_FILE"
    rm -f "$tags_file"
    log "Found $count versions"
    write_status "ready:$count"
}

backup_config() {
    local configdir
    configdir=$(uci_get configdir "")
    { [ -z "$configdir" ] || [ ! -d "$configdir" ]; } && return 0
    local ver; ver=$(uci_get installed_version "")
    [ -z "$ver" ] && ver="unknown"
    local backup_file="$UPDATE_DIR/gately_${ver}_$(date +%Y%m%d%H%M%S).tar.gz"
    tar -czf "$backup_file" -C "$(dirname "$configdir")" "$(basename "$configdir")" 2>/dev/null
    log "Config backed up: $backup_file"
}

cmd_download() {
    local tag="$1" filename="$2" binpath="${3:-$(uci_get binpath /usr/bin/gately)}"
    [ -z "$tag" ]      && die "invalid_request" "download: missing tag"
    [ -z "$filename" ] && die "invalid_request" "download: missing filename"

    local dl
    dl=$(do_download "$RELEASES_FILE" "$tag" "$filename") || exit 1
    write_status "installing:$tag"

    local xdir="$UPDATE_DIR/extract"
    rm -rf "$xdir" && mkdir -p "$xdir"
    log "Extracting..."
    case "$filename" in
        *.tar.gz|*.tgz) tar -xzf "$dl" -C "$xdir" 2>/dev/null \
                             || die "extract_failed" "Extract failed: $filename" ;;
        *) die "unsupported_format" "Unsupported format: $filename" ;;
    esac

    local bin; bin=$(find "$xdir" -type f -name "gately" | head -1)
    [ -z "$bin" ] && die "binary_not_found" "Binary 'gately' not found in archive"
    log "Found binary: $bin"

    mkdir -p "$(dirname "$binpath")"
    backup_config
    log "Stopping service..."
    /etc/init.d/gately stop 2>/dev/null; sleep 1

    log "Installing to: $binpath"
    cp "$bin" "$binpath" && chmod 755 "$binpath" \
        || die "install_failed" "Failed to install to $binpath"
    rm -rf "$xdir" "$dl"

    log "Starting service..."
    /etc/init.d/gately start 2>/dev/null
    local ver; ver=$(tag_to_ver "$tag")
    save_installed_version "${ver:-$tag}"
    log "Installation complete: ${ver:-$tag}"
    write_status "done:${ver:-$tag}"
}

maybe_update() {
    local cur="$1" latest="$2" label="$3"
    if [ -n "$cur" ] && [ -n "$latest" ] && ! version_lt "$cur" "$latest"; then
        log "$label is up to date ($cur)"
        return 1
    fi
    return 0
}

cmd_auto() {
    local reltype arch binpath
    reltype=$(uci_get release_type stable)
    arch=$(detect_arch)
    binpath=$(uci_get binpath /usr/bin/gately)

    init_dir
    rm -f "$PROGRESS_FILE"
    write_status "checking"
    log "Auto update: channel=$reltype arch=$arch"

    local cur_ver=""
    if [ -x "$binpath" ]; then
        cur_ver=$(get_installed_version)
        log "Current gately: ${cur_ver:-unknown}"
    else
        log "Gately binary not found, will download and install it"
    fi

    cmd_check "$reltype" "$arch"
    [ -f "$RELEASES_FILE" ] || die "check_failed" "Failed to check upstream versions"

    local latest_tag best_file
    latest_tag=$(grep -o '"tag":"[^"]*"' "$RELEASES_FILE" | head -1 | cut -d'"' -f4)
    best_file=$(grep -o '"best":"[^"]*"' "$RELEASES_FILE" | head -1 | cut -d'"' -f4)
    [ -z "$latest_tag" ] && die "check_failed" "Cannot parse latest tag"
    [ -z "$best_file" ]  && die "check_failed" "Cannot parse best file"

    log "Latest: $latest_tag (current: ${cur_ver:-none})"

    local done_msg="ok"
    if maybe_update "$cur_ver" "$(tag_to_ver "$latest_tag")" "Gately"; then
        cmd_download "$latest_tag" "$best_file" "$binpath"
        done_msg=$(tag_to_ver "$latest_tag")
    fi

    write_status "done:${done_msg}"
    log "Auto update complete"
}

case "$1" in
    check)       init_dir; LOG_TO_FILE="$LOG_FILE"; : > "$LOG_FILE"; cmd_check "$2" "$3" ;;
    download)    init_dir; LOG_TO_FILE="$LOG_FILE"; : > "$LOG_FILE"; cmd_download "$2" "$3" "$4" ;;
    auto|"")     init_dir; LOG_TO_FILE="$AUTO_LOG"; : > "$AUTO_LOG"; cmd_auto ;;
    detect_arch) detect_arch ;;
    *)
        echo "Usage: $0 {check|download|auto|detect_arch}"
        exit 1 ;;
esac
