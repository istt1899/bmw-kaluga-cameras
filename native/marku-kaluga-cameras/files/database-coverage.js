'use strict';
// Counts source records, never claims a count of physical camera complexes.
var info=require('./camera-info');
function numeric(value){return Number.isFinite(value)&&value>0&&value<=300;}
function summarize(records,zones){
 var describe=info.createDescriber(records),zoneIds=Object.create(null);
 zones.forEach(function(z){zoneIds[z.id]=true;});
 var result={complete:false,sourceRecords:records.length,directLimit:0,referenceLimit:0,unknownLimit:0,roadZones:zones.length,numericRoadZones:zones.filter(function(z){return numeric(z.limit);}).length,recordsWithoutRoadZone:0,facingKnown:0,captureSideKnown:0};
 records.forEach(function(record){
  var detail=describe(record);
  if(numeric(detail.cameraLimitKmh))result.directLimit++;
  else if(detail.limitReference&&detail.limitReference.state==='known'&&numeric(detail.limitReference.valueKmh))result.referenceLimit++;
  else result.unknownLimit++;
  if(!zoneIds[record.id])result.recordsWithoutRoadZone++;
  if(detail.cameraFacing.state==='mapped')result.facingKnown++;
  if(detail.captureDirectionVerified)result.captureSideKnown++;
 });
 return result;
}
module.exports={summarize:summarize};
