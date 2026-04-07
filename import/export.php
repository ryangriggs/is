<?php
/**
 * export.php — Run this on the OLD server from the old PHP directory.
 *
 * Usage:
 *   php export.php
 *
 * Edit the DB credentials below, then copy the generated .json files
 * to the import/ directory on the new server and run import.js.
 */

// ---- Database credentials ----
$host = 'localhost';
$user = 'YOUR_DB_USER';
$pass = 'YOUR_DB_PASS';
$db   = 'is';               // old database name

// ---- Old code generation (mirrors common.php) ----
$remap    = ['i' => 'v', 'l' => 'w', 'o' => 'x', '1' => 'y', '0' => 'z'];
define('MAP_BASE', 31);     // 36 - count($remap)

function id_to_key($id) {
    global $remap;
    $key = base_convert($id, 10, MAP_BASE);
    foreach ($remap as $from => $to) {
        $key = str_replace($from, $to, $key);
    }
    return $key;
}

// ---- Connect ----
$conn = new mysqli($host, $user, $pass, $db);
$conn->set_charset('utf8mb4');
if ($conn->connect_error) {
    die("Connection failed: " . $conn->connect_error . "\n");
}

$base_dir = __DIR__;    // directory containing text/, html/, img/ subdirs

echo "Connected to database '$db'\n\n";

// ----------------------------------------------------------------
// 1. Links (URL + text pastes + HTML pastes)
//    Images (type 4) are skipped — copy img/ manually if needed.
// ----------------------------------------------------------------
$result = $conn->query(
    "SELECT id, type, link, ip FROM links WHERE type IN (0, 1, 2) ORDER BY id"
);
if (!$result) die("Query failed: " . $conn->error . "\n");

$links        = [];
$skipped_urls = 0;
$skipped_files = 0;

while ($row = $result->fetch_assoc()) {
    $type = (int)$row['type'];
    $code = id_to_key((int)$row['id']);

    $entry = [
        'id'   => (int)$row['id'],
        'code' => $code,
        'type' => $type,
        'link' => $row['link'] ?? '',
        'ip'   => $row['ip'] ?? null,
    ];

    if ($type === 0) {
        // URL — skip blank/invalid
        $dest = trim($row['link'] ?? '');
        if ($dest === '' || (!str_starts_with($dest, 'http') && !str_starts_with($dest, 'ftp'))) {
            $skipped_urls++;
            continue;
        }

    } elseif ($type === 1) {
        // Text paste — content lives in text/{code}.txt
        $file = "$base_dir/text/$code.txt";
        if (!file_exists($file)) {
            $skipped_files++;
            continue;
        }
        $entry['content'] = file_get_contents($file);

    } elseif ($type === 2) {
        // HTML paste — content lives in html/{code}.html
        $file = "$base_dir/html/$code.html";
        if (!file_exists($file)) {
            $skipped_files++;
            continue;
        }
        $entry['content'] = file_get_contents($file);
    }

    $links[] = $entry;
    if (count($links) % 5000 === 0) {
        echo "  ... " . count($links) . " links processed\n";
    }
}

file_put_contents('links.json',
    json_encode($links, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
);
echo "links.json: " . count($links) . " records exported";
if ($skipped_urls)  echo " ($skipped_urls blank/invalid URLs skipped)";
if ($skipped_files) echo " ($skipped_files paste files not found, skipped)";
echo "\n";

// ----------------------------------------------------------------
// 2. Bookmarks
// ----------------------------------------------------------------
$result = $conn->query(
    "SELECT id, user_code, title, url, category, shortlink, date FROM bookmarks ORDER BY user_code, id"
);
if (!$result) die("Query failed: " . $conn->error . "\n");

$bookmarks = [];
while ($row = $result->fetch_assoc()) {
    $bookmarks[] = $row;
}

file_put_contents('bookmarks.json',
    json_encode($bookmarks, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
);
echo "bookmarks.json: " . count($bookmarks) . " records exported\n";

// ----------------------------------------------------------------
// 3. Tracking (optional — can be large)
//    Default: most recent 100,000 records.
//    To import all: remove the LIMIT clause (may produce a very large file).
//    To skip entirely: leave track.json out of the import/ directory.
// ----------------------------------------------------------------
$track_count = $conn->query("SELECT COUNT(*) AS n FROM track")->fetch_assoc()['n'];
echo "\ntrack table has $track_count rows total.\n";

if ($track_count > 0) {
    echo "Exporting most recent 100,000 tracking records...\n";
    echo "(Edit this script to change the limit or remove it to export all.)\n";

    $result = $conn->query(
        "SELECT link_id, link, date, ip, browser, referral FROM track ORDER BY id DESC LIMIT 100000"
    );

    $track = [];
    while ($row = $result->fetch_assoc()) {
        $track[] = $row;
    }

    file_put_contents('track.json',
        json_encode($track, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
    );
    echo "track.json: " . count($track) . " records exported\n";
}

$conn->close();
echo "\nDone. Copy *.json files to the import/ directory on the new server.\n";
