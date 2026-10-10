"""Independent minimal runtime derivation; imports perform no collection."""
import copy
import hashlib
import json
from pathlib import Path
import re

SCOPE = None
F = None
ROLES = ('default','media-egress','recharge-control','registration-control')
FORMAL_TABLE_SHA = None

def _configure(online,contract):
    global SCOPE,F,FORMAL_TABLE_SHA
    SCOPE=online.__dict__;F=online.DECLARATION_EQUIVALENCE_FIELDS
    if json.loads(json.dumps(F)) != contract['fields']:
        raise RuntimeError('PACKAGE_SCHEMA_CHANGED')
    FORMAL_TABLE_SHA=contract['formalTableSha256']

OWNER_KEY = 'id-business-v2.online-recharge.declaration-reference-owner'
HEX = re.compile('[a-f0-9]{64}\\Z')
NONCE = re.compile('[a-f0-9]{32}\\Z')
VERSION = re.compile('[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\Z')
MEASURED_KEYS = frozenset(('matched','reason','actualRawConfigurationSha256','referenceRawConfigurationSha256',
 'actualDeclarationNormalizedSha256','referenceDeclarationNormalizedSha256','historicalRawHashMatchClaimed',
 'authority','productionEligible','status','actualResourceSha256','sourceFileSealsSha256','referenceResourceSha256',
 'sourceUnchangedBeforeAndAfter','referenceNeverStarted','referenceModelSha256','cleanup'))
ROOT_KEYS = frozenset(('producer','recoveryPolicy','historicalFiles','anchors','actual','adminProjection',
 'configurationFiles','workspaceFiles','environmentFileSha256','stableObservation','sourceArchiveBytesSha256',
 'generatorRulesSha256'))
FACT_KEYS = frozenset(('version','formalTableSha256','sourceFileSealsSha256','generator',
 'source','referenceRegistry','referenceInputs','stableBefore','stableAfter'))
SOURCE_FACT_KEYS = ('renderedDeclarationSha256','normalizedModelSha256','apiDeclaredHash',
 'expectedEnvironmentSha256','referenceEnvironmentSha256')
REGISTRY_KEYS = ('container','networks','volume')
CONTAINER_KEYS = ('id','name','owner','createdAtSha256','creationMetadataSha256','preCleanupMetadataSha256',
 'stateAtCreate','stateBeforeCleanup')
NETWORK_KEYS = ('id','name','owner','createdAtSha256','creationMetadataSha256','preCleanupMetadataSha256')
VOLUME_KEYS = ('name','owner','createdAtSha256','creationMetadataSha256','preCleanupMetadataSha256')
STATE_KEYS = ('status','running','pid','startedAtSha256','restartCount')
INPUT_KEYS = ('modelCanonicalSha256','surrogateEnvironmentSha256','emptyEnvironmentBytesSha256',
 'emptyDockerConfigBytesSha256','beforeFileSealsSha256','afterFileSealsSha256')


class MissingFacts(RuntimeError):
    pass


def check(ok):
    if not ok:
        raise RuntimeError('PROTOTYPE_P3_INPUT_INVALID')


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def byte_digest(value):
    check(type(value) is bytes)
    return hashlib.sha256(value).hexdigest()


def exact(value,fields):
    check(type(value) is dict and set(value)==set(fields))
    return value


def hashes(value,fields):
    exact(value,fields)
    check(all(type(v) is str and HEX.fullmatch(v) for v in value.values()))
    return value


def zero_state(value):
    exact(value,STATE_KEYS)
    return (value['status']=='created' and value['running'] is False and type(value['pid']) is int
      and value['pid']==0 and value['startedAtSha256']==byte_digest(b'0001-01-01T00:00:00Z')
      and type(value['restartCount']) is int and value['restartCount']==0)


def registry(value):
    exact(value,REGISTRY_KEYS)
    c=exact(value['container'],CONTAINER_KEYS)
    owner=c['owner'];check(type(owner) is str and NONCE.fullmatch(owner))
    project='online-recharge-reference-'+owner
    check(type(c['id']) is str and HEX.fullmatch(c['id']) and c['name']=='/'+project+'-api-1')
    check(zero_state(c['stateAtCreate']) and zero_state(c['stateBeforeCleanup'])
          and c['stateAtCreate']==c['stateBeforeCleanup'])
    exact(value['networks'],ROLES)
    for role,row in value['networks'].items():
        exact(row,NETWORK_KEYS)
        check(type(row['id']) is str and HEX.fullmatch(row['id']) and row['name']==project+'_'+role
              and row['owner']==owner)
    v=exact(value['volume'],VOLUME_KEYS)
    check(v['name']==project+'_auto_registration_data' and v['owner']==owner)
    all_rows=[c,*value['networks'].values(),v]
    for row in all_rows:
        check(all(type(row[key]) is str and HEX.fullmatch(row[key]) for key in
                  ('createdAtSha256','creationMetadataSha256','preCleanupMetadataSha256'))
              and row['creationMetadataSha256']==row['preCleanupMetadataSha256'])
    check(len({n['id'] for n in value['networks'].values()})==4)
    return owner


def adapter42_registered(value):
    """Project additional private identity records back to the existing42 seal."""
    return {'container':value['container']['creationMetadataSha256'],
       'networks':{role:row['creationMetadataSha256'] for role,row in value['networks'].items()},
       'volume':value['volume']['creationMetadataSha256']}


def validate_facts(measured,facts,root):
    if facts is None:
        raise MissingFacts('PROTOTYPE_MEASUREMENT_FACTS_MISSING')
    exact(measured,MEASURED_KEYS);exact(facts,FACT_KEYS);exact(root,ROOT_KEYS)
    check(measured['matched'] is True and measured['reason']=='COMPLETE_EQUAL'
          and measured['status']=='CONTROL_ONLY_DECLARATION_MEASURED'
          and measured['historicalRawHashMatchClaimed'] is False
          and measured['authority'] is False and measured['productionEligible'] is False)
    check(type(facts['version']) is int and facts['version']==1 and facts['formalTableSha256']==FORMAL_TABLE_SHA
          and facts['sourceFileSealsSha256']==measured['sourceFileSealsSha256'])
    g=exact(facts['generator'],('engineVersion','composeVersion','rulesSha256'))
    check(all(type(g[k]) is str and VERSION.fullmatch(g[k]) for k in ('engineVersion','composeVersion'))
          and g['rulesSha256']==root['generatorRulesSha256'] and HEX.fullmatch(g['rulesSha256']))
    hashes(facts['source'],SOURCE_FACT_KEYS)
    # Stable source intent must not be the UUID/project/resource-bearing R model.
    check(facts['source']['normalizedModelSha256'] != measured['referenceModelSha256'])
    owner=registry(facts['referenceRegistry'])
    check(digest(adapter42_registered(facts['referenceRegistry']))==measured['referenceResourceSha256'])
    inputs=hashes(facts['referenceInputs'],INPUT_KEYS)
    check(inputs['modelCanonicalSha256']==measured['referenceModelSha256']
          and inputs['surrogateEnvironmentSha256']==facts['source']['referenceEnvironmentSha256']
          and inputs['emptyEnvironmentBytesSha256']==byte_digest(b'')
          and inputs['emptyDockerConfigBytesSha256']==byte_digest(b'{}\n')
          and inputs['beforeFileSealsSha256']==inputs['afterFileSealsSha256'])
    hashes(root['stableObservation'],F['stableObservation'])
    for key in ('stableBefore','stableAfter'):
        hashes(facts[key],F['stableObservation'])
        check(facts[key]==root['stableObservation'])
    check(root['stableObservation']['actualResourceSha256']==measured['actualResourceSha256']
          and root['stableObservation']['snapshotSha256']==digest(root['actual']))
    cleanup=exact(measured['cleanup'],('ownedContainersRemaining','ownedNetworksRemaining','ownedVolumesRemaining',
                                      'exactOwnerCreationSealsVerified','existingResourcesMutated'))
    check(all(type(cleanup[k]) is int and cleanup[k]==0 for k in
              ('ownedContainersRemaining','ownedNetworksRemaining','ownedVolumesRemaining'))
          and cleanup['exactOwnerCreationSealsVerified'] is True and cleanup['existingResourcesMutated'] is False
          and measured['referenceNeverStarted'] is True and measured['sourceUnchangedBeforeAndAfter'] is True)
    return owner


def construct_preview(measured, *, root, facts=None, purpose, preflight_raw=None, prior_registry=None):
    """Exact existing P3 only. No bool input can establish source authority.

    Root's inputs must come from its trusted acquisitions/full validators. Facts
    must come from proposed real in-process measurement read nodes, never a P/F
    claim. This runtime prototype emits no authoritative receipt or origin.
    """
    owner=validate_facts(measured,facts,root)
    check(purpose in ('INDEPENDENT_PREFLIGHT','DEPLOYMENT_REMEASURE'))
    original=root['recoveryPolicy']['preflight']['services']
    check(digest(root['recoveryPolicy'])==SCOPE['RECOVERY_POLICY_SHA256'])
    historical=exact(root['historicalFiles'],F['historicalFiles'])
    check(all(type(v) is bytes and 0<len(v)<=256*1024 for v in historical.values()))
    source=facts['source']
    semantic={
       'producer':copy.deepcopy(root['producer']),
       'fixedRecovery':{**SCOPE['DECLARATION_EQUIVALENCE_FIXED'],
          'recoveryMarkerSha256':digest(SCOPE['recovery_marker'](root['recoveryPolicy']))},
       'historicalFiles':{name:byte_digest(raw) for name,raw in historical.items()},
       'anchors':copy.deepcopy(root['anchors']),'original':copy.deepcopy(original),'actual':copy.deepcopy(root['actual']),
       'sourceBindings':{
          'configurationFilesSha256':digest(root['configurationFiles']),
          'workspaceFilesSha256':digest(root['workspaceFiles']),
          'environmentFileSha256':root['environmentFileSha256'],
          **copy.deepcopy(source),'apiImageId':root['actual']['api']['image'],
          'apiImageReference':root['actual']['api']['reference'],'actualResourceSha256':measured['actualResourceSha256']},
       'apiEquivalence':{'rulesSha256':g_sha(facts),
          'oldRawConfigurationSha256':original['api']['configurationSha256'],
          'actualRawConfigurationSha256':measured['actualRawConfigurationSha256'],
          'normalizedActualSha256':measured['actualDeclarationNormalizedSha256'],
          'normalizedReferenceSha256':measured['referenceDeclarationNormalizedSha256']},
       'adminProjection':copy.deepcopy(root['adminProjection']),'stableObservation':copy.deepcopy(root['stableObservation'])}
    counts={'containers':1,'networks':len(facts['referenceRegistry']['networks']),'volumes':1}
    measurement={
       'purpose':purpose,'executionNonce':owner,'sourceArchiveBytesSha256':root['sourceArchiveBytesSha256'],
       'referenceRegistrySha256':digest(facts['referenceRegistry']),
       'referenceRawConfigurationSha256':measured['referenceRawConfigurationSha256'],
       'referenceModelSha256':measured['referenceModelSha256'],
       'engineVersionSha256':byte_digest(facts['generator']['engineVersion'].encode()),
       'composeVersionSha256':byte_digest(facts['generator']['composeVersion'].encode()),
       'neverStarted':zero_state(facts['referenceRegistry']['container']['stateAtCreate'])
           and zero_state(facts['referenceRegistry']['container']['stateBeforeCleanup']),
       'cleanupVerified':True,'realEnvironmentPersisted':False,'referenceCounts':counts,
       'stableBefore':copy.deepcopy(facts['stableBefore']),'stableAfter':copy.deepcopy(facts['stableAfter']),
       'priorIndependentPreflightBytesSha256':None,'priorProofSha256':None}
    if purpose=='INDEPENDENT_PREFLIGHT':
        check(preflight_raw is None and prior_registry is None)
    else:
        check(type(preflight_raw) is bytes and 0<len(preflight_raw)<65536 and prior_registry is not None)
        before=SCOPE['closed_recovery_json'](NoneDriver(),preflight_raw)
        first=before.get('pendingOnlineMigrationOrigin',{}).get('restoredConfigurationProof')
        SCOPE['validate_declaration_equivalence_proof'](NoneDriver(),first)
        prior_owner=registry(prior_registry)
        check(digest(prior_registry)==first['measurement']['referenceRegistrySha256']
              and prior_owner==first['measurement']['executionNonce'] and owner!=prior_owner
              and facts['referenceRegistry']['container']['id']!=prior_registry['container']['id']
              and not {n['id'] for n in facts['referenceRegistry']['networks'].values()}
                    & {n['id'] for n in prior_registry['networks'].values()}
              and facts['referenceRegistry']['volume']['name']!=prior_registry['volume']['name']
              and semantic==first['semantic'])
        measurement['priorIndependentPreflightBytesSha256']=byte_digest(preflight_raw)
        measurement['priorProofSha256']=digest(first)
    proof={'kind':SCOPE['DECLARATION_EQUIVALENCE_KIND'],'version':3,'service':'api',
           'semantic':semantic,'measurement':measurement}
    SCOPE['validate_declaration_equivalence_proof'](NoneDriver(),proof)
    if purpose=='DEPLOYMENT_REMEASURE':
        SCOPE['declaration_equivalence_pair_seal'](NoneDriver(),first,proof,preflight_raw)
    return proof


def g_sha(facts):
    return digest({'formalTableSha256':FORMAL_TABLE_SHA,'generatorRulesSha256':facts['generator']['rulesSha256']})


class NoneDriver:
    @staticmethod
    def require(ok,_code):
        check(ok)
