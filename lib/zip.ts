const encoder = new TextEncoder();
const crcTable = Array.from({length:256},(_,index) => { let crc=index; for(let i=0;i<8;i++) crc=(crc&1) ? 0xedb88320^(crc>>>1) : crc>>>1; return crc>>>0; });
function crc32(data: Uint8Array) { let crc=0xffffffff; for(const value of data) crc=crcTable[(crc^value)&255]^(crc>>>8); return (crc^0xffffffff)>>>0; }
function header(length: number) { const bytes=new Uint8Array(length); return {bytes,view:new DataView(bytes.buffer)}; }

// A standards-compliant stored ZIP avoids worker filesystem/native dependencies.
export function zipTextFiles(files: Record<string,string>): Uint8Array {
  const locals:Uint8Array[]=[], centrals:Uint8Array[]=[]; let offset=0,centralSize=0;
  for(const [filename,text] of Object.entries(files)) {
    const name=encoder.encode(filename), data=encoder.encode(text), checksum=crc32(data);
    const local=header(30+name.length), v=local.view;
    v.setUint32(0,0x04034b50,true); v.setUint16(4,20,true); v.setUint16(6,0x800,true); v.setUint16(12,33,true); v.setUint32(14,checksum,true); v.setUint32(18,data.length,true); v.setUint32(22,data.length,true); v.setUint16(26,name.length,true); local.bytes.set(name,30);
    const central=header(46+name.length), c=central.view;
    c.setUint32(0,0x02014b50,true); c.setUint16(4,20,true); c.setUint16(6,20,true); c.setUint16(8,0x800,true); c.setUint16(14,33,true); c.setUint32(16,checksum,true); c.setUint32(20,data.length,true); c.setUint32(24,data.length,true); c.setUint16(28,name.length,true); c.setUint32(42,offset,true); central.bytes.set(name,46);
    locals.push(local.bytes,data); centrals.push(central.bytes); offset+=local.bytes.length+data.length; centralSize+=central.bytes.length;
  }
  const end=header(22); end.view.setUint32(0,0x06054b50,true); end.view.setUint16(8,centrals.length,true); end.view.setUint16(10,centrals.length,true); end.view.setUint32(12,centralSize,true); end.view.setUint32(16,offset,true);
  const output=new Uint8Array(offset+centralSize+22); let cursor=0;
  for(const bytes of [...locals,...centrals,end.bytes]) { output.set(bytes,cursor); cursor+=bytes.length; }
  return output;
}
