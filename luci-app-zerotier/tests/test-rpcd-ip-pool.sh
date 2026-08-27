#!/bin/sh
set -eu

zt_test_repo="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
zt_test_dir="$(mktemp -d /tmp/zerotier-controller-test.XXXXXX)"
zt_test_bin="$zt_test_dir/bin"
zt_test_payload="$zt_test_dir/payload.json"
zt_test_request_log="$zt_test_dir/requests.log"
zt_test_ucode_log="$zt_test_dir/ucode.log"
mkdir -p "$zt_test_bin"
trap 'rm -rf "$zt_test_dir"' EXIT
ln -s "$zt_test_repo/tests/fixtures/mock-curl" "$zt_test_bin/curl"

export PATH="$zt_test_bin:$PATH"
export ZT_CONTROLLER_TOKEN=test-token
export ZT_TEST_PAYLOAD="$zt_test_payload"
export ZT_TEST_REQUEST_LOG="$zt_test_request_log"
export ZT_TEST_UCODE_LOG="$zt_test_ucode_log"
export ZT_UCODE_BIN="$zt_test_repo/tests/fixtures/mock-ucode"
export ZT_UCODE_SCRIPT="$zt_test_repo/root/usr/libexec/rpcd/zerotier-controller.ucode"

run_tests_for_target() {
	target_cmd="$1"
	echo "Running test suite against: $target_cmd"

	zt_networks="$(printf '%s\n' '{}' | $target_cmd call list_networks)"
	printf '%s' "$zt_networks" | jq -e '
		.networks == [{"id":"8056c2e21c000001","name":"home_zj"}]
	' >/dev/null

	zt_created="$(printf '%s\n' '{"name":"lab","cidr":"10.42.7.9/24"}' | $target_cmd call create_network)"
	printf '%s' "$zt_created" | jq -e '.id == "8056c2e21c000002"' >/dev/null
	jq -e '
		.name == "lab" and
		.v4AssignMode.zt == true and
		.ipAssignmentPools == [{"ipRangeStart":"10.42.7.1","ipRangeEnd":"10.42.7.254"}] and
		.routes == [{"target":"10.42.7.0/24","via":null}]
	' "$zt_test_payload" >/dev/null

	zt_create_invalid="$(printf '%s\n' '{"name":"invalid","cidr":"10.42.7.0/31"}' | $target_cmd call create_network)"
	printf '%s' "$zt_create_invalid" | jq -e '.error | contains("/8 and /30")' >/dev/null

	zt_result="$(printf '%s\n' '{"nwid":"8056c2e21c000001","cidr":"10.16.0.1/24","old_cidr":"10.10.10.0/24"}' | $target_cmd call update_ip_pool)"
	printf '%s' "$zt_result" | jq -e '
		.cidr == "10.16.0.0/24" and
		.ipRangeStart == "10.16.0.1" and
		.ipRangeEnd == "10.16.0.254"
	' >/dev/null

	jq -e '
		.v4AssignMode.zt == true and
		.ipAssignmentPools == [{"ipRangeStart":"10.16.0.1","ipRangeEnd":"10.16.0.254"}] and
		([.routes[] | select(.target == "10.10.10.0/24")] | length) == 0 and
		([.routes[] | select(.target == "10.16.0.0/24" and .via == null)] | length) == 1 and
		([.routes[] | select(.target == "192.168.50.0/24" and .via == "10.10.10.1")] | length) == 1 and
		([.routes[] | select(.target == "10.200.0.0/16" and .via == null)] | length) == 1
	' "$zt_test_payload" >/dev/null

	zt_invalid="$(printf '%s\n' '{"nwid":"8056c2e21c000001","cidr":"10.16.0.1/31","old_cidr":""}' | $target_cmd call update_ip_pool)"
	printf '%s' "$zt_invalid" | jq -e '.error | contains("/8 and /30")' >/dev/null

	zt_status="$(printf '%s\n' '{}' | $target_cmd call status)"
	printf '%s' "$zt_status" | jq -e '
		(.tokenPresent | type == "boolean") and
		(.storageWritable | type == "boolean") and
		(.freeSpaceBytes | type == "number")
	' >/dev/null

	zt_members_online="$(printf '%s\n' '{"nwid":"8056c2e21c000001","online_only":true}' | $target_cmd call list_members)"
	printf '%s' "$zt_members_online" | jq -e '
		(.members | length) == 2 and
		([.members[].id] | contains(["8056c2e21c", "bab1e61f17"]))
	' >/dev/null

	zt_members_all="$(printf '%s\n' '{"nwid":"8056c2e21c000001","online_only":false}' | $target_cmd call list_members)"
	printf '%s' "$zt_members_all" | jq -e '
		(.members | length) == 3
	' >/dev/null

	zt_backup="$(printf '%s\n' '{"nwid":"8056c2e21c000001"}' | $target_cmd call export_backup)"
	printf '%s' "$zt_backup" | jq -e '
		.nwid == "8056c2e21c000001" and
		(.backup_time | type == "string") and
		.network.id == "8056c2e21c000001" and
		(.members | type == "object")
	' >/dev/null

	: > "$zt_test_request_log"
	zt_import="$(jq -n --argjson b "$zt_backup" '{ backup_data: ($b | tojson) }' | $target_cmd call import_backup)"
	printf '%s' "$zt_import" | jq -e '
		.restored == true and
		.nwid == "8056c2e21c000001" and
		.source_nwid == "8056c2e21c000001" and
		.mode == "restore" and
		.restored_members == 3
	' >/dev/null
	grep -Fx 'POST http://127.0.0.1:9993/controller/network/8056c2e21c000001' "$zt_test_request_log" >/dev/null
	if grep -Fx 'POST http://127.0.0.1:9993/controller/network' "$zt_test_request_log" >/dev/null; then
		echo 'Backup import unexpectedly created a new network' >&2
		exit 1
	fi

	export ZT_TEST_FAIL_MEMBER=dead100000
	zt_import_member_failure="$(jq -n --argjson b "$zt_backup" '{ backup_data: ($b | tojson) }' | $target_cmd call import_backup)"
	unset ZT_TEST_FAIL_MEMBER
	printf '%s' "$zt_import_member_failure" | jq -e '
		.restored == false and
		.failed_member == "dead100000" and
		.restored_members == 2 and
		.total_members == 3 and
		(.error | contains("mock member restore failed"))
	' >/dev/null

	export ZT_TEST_NETWORK_RESPONSE='{"id":"8056c2e21c000002"}'
	zt_import_wrong_nwid="$(jq -n --argjson b "$zt_backup" '{ backup_data: ($b | tojson) }' | $target_cmd call import_backup)"
	unset ZT_TEST_NETWORK_RESPONSE
	printf '%s' "$zt_import_wrong_nwid" | jq -e '
		.restored == false and
		.nwid == "8056c2e21c000001" and
		.returned_nwid == "8056c2e21c000002" and
		(.error | contains("requested network ID"))
	' >/dev/null

	zt_invalid_member_backup="$(printf '%s' "$zt_backup" | jq '.members.invalid = {"authorized": true}')"
	: > "$zt_test_request_log"
	zt_import_invalid_member="$(jq -n --argjson b "$zt_invalid_member_backup" '{ backup_data: ($b | tojson) }' | $target_cmd call import_backup)"
	printf '%s' "$zt_import_invalid_member" | jq -e '
		.restored != true and (.error | contains("invalid member"))
	' >/dev/null
	if grep -F 'POST http://127.0.0.1:9993/controller/network/' "$zt_test_request_log" >/dev/null; then
		echo 'Invalid member backup mutated the controller' >&2
		exit 1
	fi

	zt_conflicting_nwid_backup="$(printf '%s' "$zt_backup" | jq '.network.id = "8056c2e21c000002"')"
	zt_import_conflicting_nwid="$(jq -n --argjson b "$zt_conflicting_nwid_backup" '{ backup_data: ($b | tojson) }' | $target_cmd call import_backup)"
	printf '%s' "$zt_import_conflicting_nwid" | jq -e '
		.restored != true and (.error | contains("conflicting network IDs"))
	' >/dev/null

	zt_import_bad_json="$(printf '%s\n' '{"backup_data":"not json"}' | $target_cmd call import_backup)"
	printf '%s' "$zt_import_bad_json" | jq -e '
		.restored != true and (.error | test("invalid backup"))
	' >/dev/null

	zt_import_bad_mode="$(jq -n --argjson b "$zt_backup" '{ backup_data: ($b | tojson), mode: "clone" }' | $target_cmd call import_backup)"
	printf '%s' "$zt_import_bad_mode" | jq -e '
		.restored != true and (.error | contains("invalid import mode"))
	' >/dev/null

	zt_other_controller_backup="$(printf '%s' "$zt_backup" | jq '
		.nwid = "aaaaaaaaaa000001" |
		.network.id = "aaaaaaaaaa000001" |
		.network.nwid = "aaaaaaaaaa000001"
	')"
	zt_import_other_controller="$(jq -n --argjson b "$zt_other_controller_backup" '{ backup_data: ($b | tojson) }' | $target_cmd call import_backup)"
	printf '%s' "$zt_import_other_controller" | jq -e '
		.restored == false and (.error | contains("different controller identity"))
	' >/dev/null

	: > "$zt_test_request_log"
	zt_import_migrate="$(jq -n --argjson b "$zt_other_controller_backup" '{ backup_data: ($b | tojson), mode: "migrate" }' | $target_cmd call import_backup)"
	printf '%s' "$zt_import_migrate" | jq -e '
		.restored == true and
		.mode == "migrate" and
		.nwid == "8056c2e21c000002" and
		.source_nwid == "aaaaaaaaaa000001" and
		.restored_members == 3
	' >/dev/null
	grep -Fx 'POST http://127.0.0.1:9993/controller/network/8056c2e21c______' "$zt_test_request_log" >/dev/null
	jq -e '
		.id == null and .nwid == null and .name == "home_zj"
	' "$zt_test_payload" >/dev/null

	export ZT_TEST_FAIL_MEMBER_GET=dead100000
	zt_export_member_failure="$(printf '%s\n' '{"nwid":"8056c2e21c000001"}' | $target_cmd call export_backup)"
	unset ZT_TEST_FAIL_MEMBER_GET
	printf '%s' "$zt_export_member_failure" | jq -e '
		.error | contains("mock member read failed")
	' >/dev/null
}

run_tests_for_target "$zt_test_repo/root/usr/libexec/rpcd/zerotier-controller"
grep -F "import { readfile, popen, stat, statvfs, mkstemp, mkdtemp, writefile, unlink, rmdir } from 'fs';" "$zt_test_ucode_log" >/dev/null

if command -v ucode >/dev/null 2>&1; then
	unset ZT_UCODE_BIN

	run_tests_for_target "ucode $zt_test_repo/root/usr/libexec/rpcd/zerotier-controller.ucode"

	# Wrapper integration: the rpcd entry script must hand requests to the real
	# ucode engine. The sentinel below relies on the two implementations using
	# distinct invalid-backup error texts (ucode: "payload", shell: "format").
	run_tests_for_target "$zt_test_repo/root/usr/libexec/rpcd/zerotier-controller"
	zt_engine_probe="$(printf '%s\n' '{"backup_data":"not json"}' | "$zt_test_repo/root/usr/libexec/rpcd/zerotier-controller" call import_backup)"
	printf '%s' "$zt_engine_probe" | jq -e '.error == "invalid backup payload"' >/dev/null
fi

echo 'rpcd Controller tests passed'
