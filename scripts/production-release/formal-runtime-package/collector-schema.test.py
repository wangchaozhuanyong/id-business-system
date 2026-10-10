"""Source-pinned endpoint successor tests; synthetic metadata only, no Docker."""
import copy
import hashlib
import json
from pathlib import Path
import re
import runpy
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
FIX = runpy.run_path(str(HERE / 'collector-fixture.test-support.py'))
a = FIX['a']
M = a.frozen


class EndpointSchemaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='endpoint-only-', dir=HERE)
        self.base = Path(self.temp.name)
        self.directory = self.base / 'releases' / 'source'
        self.directory.mkdir(parents=True)
        (self.base / '.runtime').mkdir()
        (self.directory / M.FILES[0]).write_bytes((HERE / 'fixture-compose.test.yml').read_bytes())
        (self.directory / M.FILES[1]).write_bytes(b'{}\n')
        (self.directory / M.FILES[2]).write_bytes(b'')
        (self.directory / M.FILES[2]).chmod(0o600)
        self.d = FIX['FakeDocker'](self.base, self.directory)

    def tearDown(self):
        self.temp.cleanup()

    def validate_actual(self):
        a.actual_endpoints(self.d.actual, self.d.source_networks, self.d.services, FIX['policy']())

    def endpoint(self):
        return self.d.actual['NetworkSettings']['Networks'][self.d.source_networks['default']['Name']]

    def observed(self):
        return {'snapshot': copy.deepcopy(self.d.services),
                'sourceFiles': {'configurationFiles': copy.deepcopy(self.d.seal['files']),
                                'workspaceFiles': {'workspace-record.json': a.sha(b'SYNTHETIC WORKSPACE RECORD')}},
                'workspaceVolume': copy.deepcopy(self.d.source_volume),
                'actualResource': {'networks': copy.deepcopy(self.d.source_networks),
                                   'volume': copy.deepcopy(self.d.source_volume)}}

    def measure(self):
        raw = self.observed()
        self.d.seal['stabilitySha256'] = a.fingerprint(a.derive.observation(
            raw, self.d.services, self.d.seal['files'], raw['actualResource']))
        with patch.object(M, 'binary_hash', return_value='e' * 64), \
                patch.object(M.shutil, 'which', return_value=FIX['policy']()['dockerPath']), \
                patch.object(a, 'native_permissions', return_value=None), \
                patch.dict(a.REVIEWED_GENERATORS, {('25.0.16', '5.5.0'): FIX['policy']()}):
            return a.measure(self.d, self.directory, services=self.d.services,
                             image_reference='source-api', image_id=FIX['IMAGE'],
                             source_seal=self.d.seal, stability_reader=lambda: copy.deepcopy(raw))

    def test_schema_is_exact_fourteen_and_full_actual_names_pass(self):
        self.assertEqual(len(a.ENDPOINT_FIELDS), 14)
        self.assertEqual(set(FIX['ENDPOINT_KEYS']), a.ENDPOINT_FIELDS)
        self.validate_actual()
        self.assertEqual(self.endpoint()['DNSNames'], [FIX['PROJECT'] + '-api-1', 'api', FIX['API_ID'][:12]])

    def test_running_names_cannot_be_null_or_empty_or_scalar(self):
        for value in (None, [], '', {}, True, 1):
            with self.subTest(type=type(value).__name__):
                self.endpoint()['DNSNames'] = value
                with self.assertRaisesRegex(a.Rejected, '^ACTUAL_NETWORK_DECLARATION$'):
                    self.validate_actual()

    def test_actual_names_order_is_significant(self):
        original = self.endpoint()['DNSNames']
        self.endpoint()['DNSNames'] = list(reversed(original))
        with self.assertRaisesRegex(a.Rejected, '^ACTUAL_NETWORK_DECLARATION$'):
            self.validate_actual()

    def test_actual_duplicate_names_not_silently_deduplicated(self):
        self.endpoint()['DNSNames'].append('api')
        with self.assertRaisesRegex(a.Rejected, '^ACTUAL_NETWORK_DECLARATION$'):
            self.validate_actual()

    def test_actual_name_extra_or_missing_or_wrong_id_refused(self):
        original = self.endpoint()['DNSNames']
        for value in (original + ['CONTROL_UNKNOWN_NAME'], original[:2], original[:2] + ['9' * 12]):
            self.endpoint()['DNSNames'] = value
            with self.assertRaisesRegex(a.Rejected, '^ACTUAL_NETWORK_DECLARATION$'):
                self.validate_actual()

    def test_old_thirteen_schema_and_unknown_fields_both_refused(self):
        for field, operation in (('DNSNames', 'remove'), ('CONTROL_EXTRA_FIELD', 'add'), ('DriverOpts', 'remove')):
            endpoint = self.endpoint()
            original = copy.deepcopy(endpoint)
            if operation == 'remove':
                endpoint.pop(field)
            else:
                endpoint[field] = None
            with self.assertRaisesRegex(a.Rejected, '^ACTUAL_NETWORK_ID_OR_MEMBERS$'):
                self.validate_actual()
            endpoint.clear()
            endpoint.update(original)

    def test_one_changed_endpoint_among_four_is_refused(self):
        last = self.d.actual['NetworkSettings']['Networks'][self.d.source_networks['registration-control']['Name']]
        last['DNSNames'] = None
        with self.assertRaisesRegex(a.Rejected, '^ACTUAL_NETWORK_DECLARATION$'):
            self.validate_actual()

    def test_source_algorithm_deduplicates_in_first_occurrence_order(self):
        meta = copy.deepcopy(self.d.actual)
        meta['Config']['Hostname'] = 'CONTROL_HOSTNAME'
        aliases = ['CONTROL_ALIAS_B', 'CONTROL_ALIAS_A', meta['Name'][1:], 'CONTROL_ALIAS_B', meta['Id'][:12]]
        self.assertEqual(a.endpoint_dns_names(meta, aliases),
                         [meta['Name'][1:], 'CONTROL_ALIAS_B', 'CONTROL_ALIAS_A', meta['Id'][:12], 'CONTROL_HOSTNAME'])

    def test_trim_prefix_is_one_slash_and_hostname_empty_is_not_added(self):
        meta = copy.deepcopy(self.d.actual)
        meta['Name'] = '//CONTROL_NAME'
        meta['Config']['Hostname'] = ''
        self.assertEqual(a.endpoint_dns_names(meta, []), ['/CONTROL_NAME', meta['Id'][:12]])

    def test_short_id_and_hostname_duplicate_preserved_once(self):
        meta = self.d.actual
        self.assertEqual(a.endpoint_dns_names(meta, [meta['Name'][1:], 'api', meta['Id'][:12]]),
                         [meta['Name'][1:], 'api', meta['Id'][:12]])

    def test_metadata_types_are_not_caller_claims(self):
        for field, value in (('Id', None), ('Id', 'CONTROL_BAD_ID'), ('Name', {}), ('Config', {})):
            meta = copy.deepcopy(self.d.actual)
            meta[field] = value
            with self.assertRaisesRegex(a.Rejected, '^ACTUAL_NETWORK_DECLARATION$'):
                a.endpoint_dns_names(meta, ['api'])
        with self.assertRaisesRegex(a.Rejected, '^ACTUAL_NETWORK_DECLARATION$'):
            a.endpoint_dns_names(self.d.actual, ['api', None])

    def test_reference_null_only_and_success_output_non_authorizing(self):
        result = self.measure()
        self.assertFalse(result['measured']['authority'])
        self.assertFalse(result['measured']['productionEligible'])
        self.assertEqual(a.REVIEWED_GENERATORS, {})
        self.assertEqual(len(self.d.removed), 6)
        self.assertEqual(self.d.created_networks, {})
        self.assertIsNone(self.d.created_volume)
        self.assertIsNone(self.d.created_container)

    def test_reference_empty_list_or_runtime_names_rejected_and_cleanup(self):
        for value in ([], ['api'], ['CONTROL_PRIVATE_SENTINEL']):
            with self.subTest(type=type(value).__name__):
                old = self.d.run
                def run(*args, **kwargs):
                    result = old(*args, **kwargs)
                    if 'create' in args and self.d.created_container is not None:
                        for row in self.d.created_container['NetworkSettings']['Networks'].values():
                            row['DNSNames'] = copy.deepcopy(value)
                    return result
                self.d.run = run
                with self.assertRaisesRegex(a.Rejected, '^REFERENCE_PENDING_ENDPOINT$') as error:
                    self.measure()
                self.assertNotIn('CONTROL_PRIVATE_SENTINEL', str(error.exception))
                self.assertEqual(self.d.created_networks, {})
                self.assertIsNone(self.d.created_volume)
                self.assertIsNone(self.d.created_container)
                self.d.run = old

    def test_reference_missing_field_rejects_and_cleanup(self):
        old = self.d.run
        def run(*args, **kwargs):
            result = old(*args, **kwargs)
            if 'create' in args and self.d.created_container is not None:
                for row in self.d.created_container['NetworkSettings']['Networks'].values():
                    row.pop('DNSNames')
            return result
        self.d.run = run
        with self.assertRaisesRegex(a.Rejected, '^REFERENCE_PENDING_ENDPOINT$'):
            self.measure()
        self.assertEqual(len(self.d.removed), 6)

    def test_unregistered_real_entry_still_refuses_before_create(self):
        self.assertEqual(a.REVIEWED_GENERATORS, {})
        with self.assertRaisesRegex(a.Rejected, '^SOURCE_NOT_MEASURED$'):
            a.measure(self.d, self.directory, services=self.d.services, image_reference='source-api',
                      image_id=FIX['IMAGE'], source_seal=self.d.seal, stability_reader=self.observed)
        self.assertFalse(any('create' in command for command, _ in self.d.calls))


class FixtureDockerPathIsolationTests(unittest.TestCase):
    def test_host_missing_or_noncanonical_path_is_ignored_and_restored(self):
        original_which=M.shutil.which
        for host_path in (None,'/synthetic-host/bin/docker'):
            with self.subTest(host_missing=host_path is None):
                with patch.object(M.shutil,'which',return_value=host_path) as host_lookup:
                    case=EndpointSchemaTests('test_reference_null_only_and_success_output_non_authorizing')
                    case.setUp()
                    try:case.test_reference_null_only_and_success_output_non_authorizing()
                    finally:
                        case.doCleanups()
                        case.tearDown()
                    self.assertIs(M.shutil.which,host_lookup)
                    host_lookup.assert_not_called()
                self.assertIs(M.shutil.which,original_which)
        for capability in (M.daemon_identity_capability,M.daemon_socket_capability):
            with self.assertRaisesRegex(RuntimeError,'^MOCK_RUNTIME_NOT_MEASURED$'):capability()


class PinnedPrimarySourceTests(unittest.TestCase):
    def source(self, name):
        return (HERE / 'sources' / name).read_text()

    def test_all_captured_primary_source_bytes_are_pinned(self):
        manifest = json.loads((HERE / 'source-inputs.json').read_bytes())
        self.assertFalse(manifest['authority'])
        self.assertFalse(manifest['productionEligible'])
        self.assertEqual(len(manifest['sources']), 14)
        for row in manifest['sources']:
            raw = (HERE / 'sources' / row['localFile']).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), row['sha256'])
            self.assertEqual(len(raw), row['bytes'])
            self.assertIn('/' + manifest['mobyCommit'] + '/', row['url']) if row['source'] == 'MOBY_FIXED_ARCHIVE' else None

    def test_actual_schema_hashes_have_closed_typed_source_and_no_property_claims(self):
        value = json.loads((HERE / 'finite-profile-source-fields.json').read_bytes())
        self.assertEqual(a.fingerprint(value['typedSchemaBindings']['networkSchemas']),
                         value['inventoryResources']['networkSchemaSha256'])
        self.assertEqual(a.fingerprint(value['typedSchemaBindings']['volumeSchemas']),
                         value['inventoryResources']['volumeSchemaSha256'])
        self.assertEqual(len(value['typedSchemaBindings']['networkSchemas']), 4)
        self.assertEqual(len(value['typedSchemaBindings']['volumeSchemas']), 1)
        for name in ('networkFields', 'volumeFields'):
            row = next(row for row in value['fields'] if row['field'] == name)
            self.assertFalse(row['actualResourceValuesVerified'])

    def test_finite_field_report_cannot_be_profile_or_qualification(self):
        value = json.loads((HERE / 'finite-profile-source-fields.json').read_bytes())
        self.assertEqual(value['registryRows'], 0)
        for name in ('authority', 'productionEligible', 'profileConstructed',
                     'actualFullMetadataCollected', 'referenceCreated'):
            self.assertFalse(value[name])
        self.assertNotEqual(set(value), a.SPEC_KEYS)
        self.assertEqual(a.REVIEWED_GENERATORS, {})
        endpoints = [row for row in value['fields'] if row['field'] in
                     ('actualEndpointFields', 'referenceEndpointFields')]
        self.assertEqual(len(endpoints), 2)
        self.assertTrue(all(row['actualRuntimeValueStatus'] == 'NOT_MEASURED' for row in endpoints))

    def test_moby_local_volume_omitted_status_source_is_explicit(self):
        source = self.source('moby2516-volume-local-local.go')
        body = source.split('func (v *localVolume) Status() map[string]interface{} {', 1)[1].split('}', 1)[0]
        self.assertIn('return nil', body)
        schema = self.source('moby2516-api-types-volume-volume.go')
        self.assertIn('Status map[string]interface{} `json:"Status,omitempty"`', schema)
        self.assertIn('ClusterVolume *ClusterVolume `json:"ClusterVolume,omitempty"`', schema)
        self.assertIn('UsageData *UsageData `json:"UsageData,omitempty"`', schema)

    def test_moby_schema_no_omitempty_and_all_fourteen_fields(self):
        source = self.source('moby2516-api-types-network-endpoint.go')
        body = source.split('type EndpointSettings struct {', 1)[1].split('\n}', 1)[0]
        fields = set(re.findall(r'^\s*([A-Z][A-Za-z0-9]*)\s+[^/\n]+', body, re.M))
        self.assertEqual(fields, a.ENDPOINT_FIELDS)
        self.assertIn('DNSNames []string', body)
        self.assertNotIn('omitempty', body)

    def test_compose_request_does_not_set_dnsnames(self):
        source = self.source('docker-compose-v5.5.0-pkg-compose-create.go')
        body = source.split('func createEndpointSettings(', 1)[1].split('// copy/pasted', 1)[0]
        literal = body.split('return &network.EndpointSettings{', 1)[1].split('}, nil', 1)[0]
        self.assertIn('Aliases:', literal)
        self.assertNotIn('DNSNames:', literal)
        creation = self.source('moby2516-daemon-container_operations.go')
        creation = creation.split('func (daemon *Daemon) updateContainerNetworkSettings(', 1)[1].split('func (daemon *Daemon) allocateNetwork(', 1)[0]
        self.assertIn('EndpointSettings: epConfig,', creation)
        self.assertNotIn('DNSNames', creation)

    def test_moby_running_rule_and_ordered_dedup_inspect_copy_are_explicit(self):
        source = self.source('moby2516-daemon-container_operations.go')
        self.assertIn('endpointConfig.DNSNames = buildEndpointDNSNames(container, endpointConfig.Aliases)', source)
        block = source.split('func buildEndpointDNSNames(', 1)[1].split('\nfunc ', 1)[0]
        order = ['strings.TrimPrefix(ctr.Name, "/")', 'append(dnsNames, aliases...)',
                 'stringid.TruncateID(ctr.ID)', 'ctr.Config.Hostname)', 'sliceutil.Dedup(dnsNames)']
        positions = [block.index(item) for item in order]
        self.assertEqual(positions, sorted(positions))
        dedup = self.source('moby2516-internal-sliceutil-sliceutil.go')
        self.assertIn('for _, s := range slice', dedup)
        self.assertIn('out = append(out, s)', dedup)
        inspect = self.source('moby2516-daemon-inspect.go')
        self.assertIn('apiNetworks[nwName] = epConf.EndpointSettings.Copy()', inspect)


if __name__ == '__main__':
    unittest.main()
