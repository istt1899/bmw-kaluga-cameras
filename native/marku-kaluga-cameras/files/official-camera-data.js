'use strict';
// Append a separately attributed official source layer. Never spatially merge
// official rows with OSM points or infer camera direction/speed limits.
var HOST = 'https://xn--80aebkobnwfcnsfk1e0h.xn--p1ai';
var CONTROLS = ['speed','redlight','stopline','belt','phone','pedestrian','signs_marking','road_position'];
function fail(code,message) { var e = new Error(message || code); e.code = code; throw e; }
function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v,max) { return typeof v === 'string' && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v); }
function day(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v; }
function date(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) && isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,19) === v.slice(0,19); }
function source(v) { return typeof v === 'string' && /^https:\/\/xn--80aebkobnwfcnsfk1e0h\.xn--p1ai\/upload\/site40\/report\/publication\/file\/[A-Za-z0-9_-]+\.xlsx$/.test(v); }
function evidenceUrl(v) { return source(v) || v === HOST + '/r/40' || /^https:\/\/(?:www\.)?openstreetmap\.org\/(?:node|way|relation)\/\d+$/.test(v || ''); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function inspect(v,depth,budget) {
  if (++budget.count > 350000 || depth > 24) fail('OFFICIAL_COMPLEXITY');
  if (typeof v === 'string' && !text(v,8192)) fail('OFFICIAL_TEXT');
  if (typeof v === 'number' && !isFinite(v)) fail('OFFICIAL_NUMBER');
  if (v && typeof v === 'object') Object.keys(v).forEach(function(k) { if (['__proto__','prototype','constructor'].indexOf(k)>=0) fail('OFFICIAL_KEY'); inspect(v[k],depth+1,budget); });
}
function validateCatalog(catalog) {
  if (!object(catalog)) fail('OFFICIAL_SCHEMA');
  inspect(catalog,0,{count:0});
  if (Buffer.byteLength(JSON.stringify(catalog),'utf8') > 8*1024*1024) fail('OFFICIAL_SIZE');
  if (catalog.schema !== 1 || catalog.source !== 'gibdd-official' || catalog.region !== 'RU-KLU' || !source(catalog.sourceUrl) ||
      catalog.sourceIndexUrl !== HOST+'/r/40' || !/^[a-f0-9]{64}$/.test(catalog.sourceSha256 || '') || !day(catalog.publishedAt) || !date(catalog.retrievedAt) ||
      Date.parse(catalog.publishedAt) > Date.parse(catalog.retrievedAt) || catalog.sourceLastModified != null && !date(catalog.sourceLastModified) ||
      !Array.isArray(catalog.records) || !catalog.records.length || catalog.records.length > 20000) fail('OFFICIAL_SCHEMA');
  if (!object(catalog.reuse) || catalog.reuse.attributionRequired !== true || catalog.reuse.statementUrl !== HOST+'/r/40#copyright') fail('OFFICIAL_ATTRIBUTION');
  var ids=Object.create(null),rows=Object.create(null),positions=Object.create(null);
  catalog.records.forEach(function(r) {
    if (!object(r) || !/^gibdd:ru-klu:[a-f0-9]{16}$/.test(r.id || '') || ids[r.id]) fail('OFFICIAL_ID'); ids[r.id]=true;
    if (!object(r.position) || !Number.isFinite(r.position.lat) || !Number.isFinite(r.position.lon) || r.position.lat < 53 || r.position.lat > 56 || r.position.lon < 33 || r.position.lon > 38) fail('OFFICIAL_POSITION');
    if (!Number.isInteger(r.sourceRow) || r.sourceRow < 1 || r.sourceRow > 100000 || !Number.isInteger(r.sourceCoordinateIndex) || r.sourceCoordinateIndex < 0 || r.sourceCoordinateIndex > 100 || r.sourceSheet !== 'xl/worksheets/sheet1.xml') fail('OFFICIAL_SOURCE_ROW');
    rows[r.sourceRow]=true; positions[r.position.lat+','+r.position.lon]=true;
    if (!Array.isArray(r.controls) || !r.controls.length || r.controls.length > CONTROLS.length || r.controls.some(function(c,i) { return CONTROLS.indexOf(c)<0 || r.controls.indexOf(c)!==i; })) fail('OFFICIAL_CONTROLS');
    var type=r.controls.indexOf('redlight')>=0?'redlight':r.controls.indexOf('speed')>=0?'speed':'camera';
    if (r.type !== type || r.limitKmh !== null || r.captureSide !== 'unknown' || r.bearingDeg !== null || r.hardwareModel !== null) fail('OFFICIAL_UNSUPPORTED_CLAIM');
    if (r.sourceUrl !== catalog.sourceUrl || r.sourcePublishedAt !== catalog.publishedAt || r.provenance !== 'Госавтоинспекция' || r.positionKind !== 'official-location') fail('OFFICIAL_PROVENANCE');
    if (!text(r.address,1000) || !r.address.trim() || !text(r.description,250) || !text(r.rawControls,4096) || !text(r.operatingConditions,1000) ||
        r.unmappedControls !== null && !text(r.unmappedControls,4096) || !text(r.coordinatesRaw,1000)) fail('OFFICIAL_RECORD_TEXT');
    if (r.deployment !== undefined && r.deployment !== 'fixed' || r.mobile === true) fail('OFFICIAL_MOBILE_RECORD');
    if (!object(r.coordinatePrecision) || ['latDecimalPlaces','lonDecimalPlaces'].some(function(key) { return !Number.isInteger(r.coordinatePrecision[key]) || r.coordinatePrecision[key]<0 || r.coordinatePrecision[key]>10; })) fail('OFFICIAL_COORDINATE_PRECISION');
    if (!Array.isArray(r.controlEvidence) || !r.controlEvidence.length || r.controlEvidence.length > 100 || r.controlEvidence.some(function(e) { return !object(e) || r.controls.indexOf(e.control)<0 || !text(e.matchedText,1000) || !e.matchedText; }) ||
        r.controls.some(function(control) { return !r.controlEvidence.some(function(e) { return e.control===control; }); })) fail('OFFICIAL_CONTROL_EVIDENCE');
  });
  var audit=catalog.audit;
  if (!object(audit) || !Number.isInteger(audit.fixedRows) || audit.fixedRows < 1 || audit.fixedRows > 20000 || audit.acceptedRows !== Object.keys(rows).length || audit.coordinatePositions !== catalog.records.length ||
      !Array.isArray(audit.rejected) || audit.rejected.length !== audit.fixedRows-audit.acceptedRows || !Number.isInteger(audit.mobileRoutes) || audit.mobileRoutes < 0 || audit.mobileRoutes > 20000 ||
      audit.uniqueExactPositions !== undefined && audit.uniqueExactPositions !== Object.keys(positions).length) fail('OFFICIAL_AUDIT');
  if (audit.rejected.some(function(r) { return !object(r) || !Number.isInteger(r.sourceRow) || r.sourceRow<1 || !text(r.reason,500) || !r.reason; })) fail('OFFICIAL_AUDIT');
  return clone(catalog);
}
function validatePolicy(policy,catalog) {
  if (!object(policy)) fail('OFFICIAL_QUALITY_REQUIRED','Official source requires a matching reviewed quality policy');
  inspect(policy,0,{count:0});
  if (policy.schema !== 1 || policy.sourceSha256 !== catalog.sourceSha256 || !date(policy.reviewedAt) || Date.parse(policy.reviewedAt)<Date.parse(catalog.retrievedAt) || !Array.isArray(policy.excluded) || policy.excluded.length > catalog.records.length ||
      policy.links !== undefined && (!Array.isArray(policy.links) || policy.links.length>20000)) fail('OFFICIAL_QUALITY_POLICY');
  var known=Object.create(null),excluded=Object.create(null);catalog.records.forEach(function(r) { known[r.id]=true; });
  policy.excluded.forEach(function(entry) {
    if (!object(entry) || !known[entry.id] || excluded[entry.id] || !text(entry.reason,500) || !entry.reason || !evidenceUrl(entry.sourceUrl)) fail('OFFICIAL_QUALITY_EXCLUSION');
    excluded[entry.id]={id:entry.id,reason:entry.reason,sourceUrl:entry.sourceUrl};
  });
  return excluded;
}
function linkContexts(database,sourceCatalog,policy,excluded) {
  var byId=Object.create(null),official=Object.create(null),seen=Object.create(null),applied=[];
  database.records.forEach(function(r) { byId[r.id]=r; });sourceCatalog.records.forEach(function(r) { official[r.id]=r; });
  (policy.links||[]).forEach(function(link) {
    if (!object(link) || !/^osm:(?:node|way|relation):\d+$/.test(link.osmId||'') || seen[link.osmId] || !byId[link.osmId] || !official[link.officialId] || excluded[link.officialId] ||
        link.scope!=='enforcement-location') fail('OFFICIAL_CONTEXT_LINK');
    var osm=byId[link.osmId],entry=official[link.officialId],a=osm.position,b=entry.position;
    if (!object(a) || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) fail('OFFICIAL_CONTEXT_POSITION');
    var x=(b.lon-a.lon)*111320*Math.cos((a.lat+b.lat)*Math.PI/360),y=(b.lat-a.lat)*111320,distance=Math.sqrt(x*x+y*y);
    if(distance>50)fail('OFFICIAL_CONTEXT_DISTANCE');
    if(osm.officialSiteContext)fail('OFFICIAL_CONTEXT_DUPLICATE');
    seen[link.osmId]=true;
    osm.officialSiteContext={scope:'enforcement-location',sourceRecordId:entry.id,sourceUrl:sourceCatalog.sourceUrl,sourcePublishedAt:sourceCatalog.publishedAt,sourceRow:entry.sourceRow,
      controls:clone(entry.controls),rawControls:entry.rawControls,controlEvidence:clone(entry.controlEvidence),address:entry.address,operatingConditions:entry.operatingConditions};
    applied.push({osmId:link.osmId,officialId:link.officialId,scope:link.scope,distanceM:Math.round(distance*10)/10});
  });return applied;
}
function augment(database,catalog,policy) {
  if (!object(database) || database.region !== 'RU-KLU' || !Array.isArray(database.records) || database.records.length > 20000) fail('OFFICIAL_DATABASE');
  var sourceCatalog=validateCatalog(catalog),excluded=validatePolicy(policy,sourceCatalog),result=clone(database),ids=Object.create(null);
  result.records.forEach(function(r) { if (!r || !text(r.id,128) || ids[r.id]) fail('OFFICIAL_DATABASE_ID');ids[r.id]=true; });
  var accepted=0;
  sourceCatalog.records.forEach(function(r) {
    if (ids[r.id]) fail('OFFICIAL_DUPLICATE_SOURCE');
    if (excluded[r.id]) return;
    ids[r.id]=true;accepted++;
    result.records.push({id:r.id,type:r.type,controls:clone(r.controls),position:clone(r.position),limitKmh:null,captureSide:'unknown',bearingDeg:null,hardwareModel:null,
      provenance:'Госавтоинспекция',providerId:'gibdd-official',positionKind:'official-location',operatingStatus:'listed-as-of-publication',officialListPublishedAt:sourceCatalog.publishedAt,sourcePublishedAt:sourceCatalog.publishedAt,
      sourceUrl:sourceCatalog.sourceUrl,positionSourceUrl:sourceCatalog.sourceUrl,sourceRecordId:r.id,siteSourceRecordId:'sheet1:'+r.sourceRow+':'+r.sourceCoordinateIndex,
      sourceRow:r.sourceRow,sourceCoordinateIndex:r.sourceCoordinateIndex,sourceSheet:r.sourceSheet,address:r.address,description:r.description,rawControls:r.rawControls,
      controlEvidence:clone(r.controlEvidence),unmappedControls:r.unmappedControls,operatingConditions:r.operatingConditions,coordinatePrecision:clone(r.coordinatePrecision||{}),coordinatesRaw:r.coordinatesRaw,
      sourceQuality:'screened-with-explicit-exclusions'});
  });
  if (result.records.length > 20000) fail('OFFICIAL_DATABASE_SIZE');
  var contextLinks=linkContexts(result,sourceCatalog,policy,excluded);
  result.officialCount=accepted;
  result.sourceMetadata=object(result.sourceMetadata)?result.sourceMetadata:{};
  var providers=result.sourceMetadata.providers;
  if (providers !== undefined && !Array.isArray(providers)) fail('OFFICIAL_PROVIDER_METADATA');
  providers=providers||[];if (providers.some(function(p) { return !object(p) || p.id==='gibdd-official'; })) fail('OFFICIAL_DUPLICATE_PROVIDER');
  if (!providers.some(function(p) { return p.id==='osm'; })) providers.push({id:'osm',title:'OpenStreetMap',sourceUrl:database.providerUrl||null,
    publishedAt:database.sourceTimestamp,pbfMd5:database.pbfMd5||null,positionRecords:(database.osmCount||0)+(database.relationCount||0),countUnit:'mapped source objects, not verified physical devices'});
  providers.push({id:'gibdd-official',title:'Госавтоинспекция — Калужская область',sourceUrl:sourceCatalog.sourceUrl,indexUrl:sourceCatalog.sourceIndexUrl,publishedAt:sourceCatalog.publishedAt,
    retrievedAt:sourceCatalog.retrievedAt,sourceLastModified:sourceCatalog.sourceLastModified||null,sourceSha256:sourceCatalog.sourceSha256,reuse:clone(sourceCatalog.reuse),
    positionRecords:sourceCatalog.records.length,acceptedPositionRecords:accepted,sourceRows:sourceCatalog.audit.fixedRows,acceptedRows:sourceCatalog.audit.acceptedRows,rejectedRows:sourceCatalog.audit.rejected.length,
    rejected:sourceCatalog.audit.rejected.map(function(r) { return{sourceRow:r.sourceRow,reason:r.reason}; }),mobileRoutesExcluded:sourceCatalog.audit.mobileRoutes,
    qualityReviewedAt:policy.reviewedAt,qualityExclusions:Object.keys(excluded).map(function(id) { return excluded[id]; }),contextLinks:contextLinks,countUnit:'coordinate positions from source rows; not a deduplicated count of physical devices'});
  result.sourceMetadata.providers=providers;
  result.sourceMetadata.countUnit='source-position-records';result.sourceMetadata.physicalDeviceCount=null;
  result.licence='OSM: ODbL-1.0; МВД: воспроизведение с указанием источника; сообщения владельца: разрешено владельцем';
  result.source=result.displaySource='Mixed OSM + Госавтоинспекция + сообщения владельца';
  return result;
}
module.exports={augment:augment,validateCatalog:validateCatalog,validatePolicy:validatePolicy};
