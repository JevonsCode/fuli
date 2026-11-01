/** fuli-avatar v0.5.0. Pure, dependency-free, deterministic SVG generator. */
/* Generated from src/ by npm run build; do not edit. */
/** Render version 3, kept verbatim so stored v3 identities still draw identically. Do not change output. */
const V3_VERSION = '3';
const V3_PALETTES = [
 {name:'苔原绿',bg:'#E3E9E2',shirt:'#345B3C',accent:'#D77632',hair:'#192D3C'},
 {name:'海盐蓝',bg:'#DEE8EC',shirt:'#3B7685',accent:'#E8B75B',hair:'#263B4B'},
 {name:'莓果紫',bg:'#EAE2E8',shirt:'#75516A',accent:'#D7976C',hair:'#403A49'},
 {name:'暖麦黄',bg:'#F0E9D7',shirt:'#BC8C38',accent:'#47766B',hair:'#594536'},
 {name:'赤陶橙',bg:'#EEDFD6',shirt:'#B86446',accent:'#59786F',hair:'#483B35'},
 {name:'雾松灰',bg:'#D6DFDA',shirt:'#566C69',accent:'#C7A45A',hair:'#F0F0E8'},
];
const V3_OPTIONS = Object.freeze({palette:6,skin:5,hair:10,eyes:8,mouth:6,outfit:10,accessory:11,decoration:3});
const V3_COMBINATIONS=Object.values(V3_OPTIONS).reduce((a,b)=>a*b,1);
const V3_SKINS=['#FFE8CF','#F4D2AD','#DDB18B','#BA8768','#8E604C'];
const V3_INK='#1D3040';
function v3Rng(seed){let h=2166136261;for(const c of `${V3_VERSION}:${seed}`){h^=c.codePointAt(0);h=Math.imul(h,16777619);}return()=>{h+=0x6D2B79F5;let t=h;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
function getTraitsV3(seed='fuli',overrides={}){const random=v3Rng(String(seed));return Object.fromEntries(Object.entries(V3_OPTIONS).map(([key,count])=>{const value=overrides[key],sample=Math.floor(random()*count);return[key,Number.isInteger(value)&&value>=0&&value<count?value:sample];}));}
function createAvatarV3(seed='fuli',config={}){
 const t=getTraitsV3(seed,config.traits);const p=V3_PALETTES[t.palette],skin=V3_SKINS[t.skin];const size=Number.isInteger(config.size)&&config.size>=16&&config.size<=4096?config.size:256;
 const path=(d,fill='none',width=5)=>`<path d="${d}" fill="${fill}" stroke="${V3_INK}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
 const circle=(x,y,r,fill,stroke=V3_INK,w=5)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${w}"/>`;
 // Shared ear anchors: left (57, 132), right (197, 132).
 const hair=[
 'M53 139Q33 106 56 69Q72 38 111 32Q170 18 197 62Q217 93 203 135L184 156L72 159Z',
 'M51 139Q33 109 48 84L40 64L58 72Q75 37 108 36Q143 21 173 38Q189 45 205 36L201 54Q219 61 216 83L205 81Q215 111 200 140Z',
 'M61 173Q32 166 36 127Q30 89 57 59Q90 20 142 29Q196 28 209 77Q216 104 210 134Q229 168 186 177Z',
 'M51 140Q34 112 47 91Q32 73 55 62Q51 41 78 43Q84 22 108 34Q128 17 148 34Q174 23 183 45Q209 39 210 63Q229 81 207 106L203 139Z',
 'M51 140Q35 94 60 61Q86 27 130 29Q179 25 201 65Q218 93 202 140Z',
 'M52 139Q36 100 59 68Q69 45 101 37L92 31Q128 12 154 30Q186 29 199 58Q215 73 208 103L201 139Z',
 'M51 137Q37 110 46 88L36 90Q43 59 69 54L63 43Q101 44 114 28Q136 38 157 26L160 38Q191 50 208 39Q210 55 197 63Q226 81 213 101L204 94L201 138Z',
 'M52 139Q34 105 52 72L43 60L63 63Q85 34 118 36Q143 21 173 36Q191 46 211 40L201 59Q220 81 204 137Z'];
 let out=`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-label="Generated FULI avatar"><rect width="256" height="256" rx="${config.rounded===false?0:36}" fill="${config.transparent?'none':p.bg}"/>`;
 if(t.decoration===1)out+='<g fill="'+p.accent+'" opacity=".35"><circle cx="37" cy="151" r="5"/><circle cx="215" cy="48" r="7"/></g>';
 if(t.decoration===2)out+=`<path d="M29 74h12m-6-6v12M211 157h12m-6-6v12" stroke="${p.accent}" stroke-width="4" stroke-linecap="round"/>`;
 hair.push('M42 143Q23 137 30 118Q18 105 29 89Q20 72 36 61Q30 42 49 38Q54 20 73 25Q87 8 104 20Q122 7 138 20Q155 8 169 24Q191 17 199 37Q221 38 219 58Q238 70 227 88Q239 105 225 120Q229 142 209 147L187 167L69 166Z',
 'M44 141Q27 126 40 109Q26 91 42 77Q34 57 55 52Q54 31 77 34Q89 15 109 29Q126 12 143 27Q165 14 178 35Q200 30 204 52Q224 57 215 77Q231 93 215 109Q226 129 206 144Z');
 // One shared transform keeps every wearable attached while giving the portrait breathing room.
 out+='<g data-part="portrait" transform="translate(20.48 22) scale(.84)">';
 // Both hair layers are filled AND edged with the selected hair color. There is no dark scalp base.
 const hairPath=d=>`<path d="${d}" fill="${p.hair}" stroke="${p.hair}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>`;
 out+='<g data-part="hair-back">'+hairPath(hair[t.hair])+'</g>';
 // Neck first, then garments with a real neckline cutout, then the overlapping face.
 out+='<g data-part="neck">'+path('M111 163L110 186Q127 204 148 186L147 162Z',skin,4.5)+'</g>';
 const cream='#F6EBDD';
 const body='M108 184L92 187Q59 193 55 223L55 235Q128 240 201 235L201 223Q197 193 164 187L148 184Q128 204 108 184Z';
 out+='<g data-part="outfit" data-style="'+t.outfit+'">'+path(body,p.shirt,5);
 if(t.outfit===0){ // Crewneck with sewn-on pocket.
  out+=path('M106 185Q128 209 150 185','none',3.5)+path('M160 207H181V220Q170 226 160 220Z','none',2.8);
 }else if(t.outfit===1){ // Open work jacket over a light tee; lapels share the shoulder seam.
  out+=path('M109 185Q128 203 147 185L151 237H105Z',cream,3.5);
  out+=path('M100 185L88 196L103 202L94 215L108 237L115 191Z',p.shirt,3.5);
  out+=path('M156 185L168 196L153 202L162 215L148 237L141 191Z',p.shirt,3.5);
  out+=path('M68 211H86M170 211H188','none',2.5);
 }else if(t.outfit===2){ // Button cardigan; no unexplained vertical blocks.
  out+=path('M108 184Q128 201 148 184L128 210Z',cream,3);
  out+=path('M108 185L128 210L148 185M128 210V237','none',3.5);
  out+=circle(132,217,1.7,cream,V3_INK,1)+circle(132,228,1.7,cream,V3_INK,1);
 }else if(t.outfit===3){ // Breton tee stripes stay within the garment silhouette.
  out+=path('M106 185Q128 209 150 185','none',3.5);
  out+=path('M67 208H189M62 220H194M60 232H196', 'none',4).replace(`stroke="${V3_INK}"`,`stroke="${cream}"`);
 }else if(t.outfit===4){ // Hoodie: two soft hood folds, a V opening, and paired drawstrings.
  out+=path('M108 184L96 188Q98 202 112 207L128 199L144 207Q158 202 160 188L148 184Q128 203 108 184Z',p.shirt,3.5);
  out+=path('M112 207V220M144 207V220','none',2.6);
  out+=circle(112,220,1.8,cream,V3_INK,1)+circle(144,220,1.8,cream,V3_INK,1);
  out+=path('M111 225L105 234H151L145 225','none',2.5);
 }else if(t.outfit===5){ // Oxford shirt, folded collar and center placket.
  out+=path('M108 184L99 191L115 204L127 194L139 204L157 191L148 184Q128 201 108 184Z',cream,3);
  out+=path('M127 196V237','none',2.5);
  out+=circle(133,212,1.6,cream,V3_INK,1)+circle(133,224,1.6,cream,V3_INK,1);
 }else if(t.outfit===6){ // Dungarees over a tee, straps meet the bib rather than the neck.
  out+=path('M106 185Q128 209 150 185','none',3);
  out+=path('M91 188L99 187L104 209H153L158 187L166 190L163 237H94Z',p.accent,3.5);
  out+=circle(104,210,2.5,cream,V3_INK,1.5)+circle(153,210,2.5,cream,V3_INK,1.5);
  out+=path('M116 217H141V227Q129 231 116 227Z','none',2.5);
 }else if(t.outfit===7){ // Soft high-neck knit with a distinct folded collar.
  out+=path('M108 183Q128 193 148 183L151 196Q128 205 105 196Z',p.shirt,3.5);
  out+=path('M113 190V196M123 193V199M133 193V199M143 190V196M72 216V233M184 216V233','none',2);
 }else if(t.outfit===8){ // Rugby polo, contrasting yoke and a compact collar.
  out+=path('M65 207H191M61 216H195','none',5).replace(`stroke="${V3_INK}"`,`stroke="${cream}"`);
  out+=path('M108 184L101 191L117 201L128 193L140 201L155 191L148 184Q128 201 108 184Z',cream,3);
  out+=path('M128 196V207','none',2.5);
 }else{ // Raglan sweatshirt with coherent sleeve seams and ribbed hem.
  out+=path('M106 185Q128 209 150 185M96 189L76 218M160 189L180 218M59 230Q128 235 197 230','none',3);
  out+=path('M117 201L128 211L139 201','none',2.5);
 }
 out+='</g>';
 // The upper skull is fill-only: a hidden dark outline would peek through light fringes.
 out+='<g data-part="face">'+path('M68 93Q88 65 129 65Q168 65 185 92L191 118Q201 109 209 121Q218 142 194 147Q187 174 156 181Q119 191 88 173Q74 165 68 147Q48 155 43 137Q37 119 52 115Q59 114 65 121Z',skin,0)+path('M207 119Q218 142 194 147Q187 174 156 181Q119 191 88 173Q74 165 68 147Q48 155 43 137Q39 126 45 121','none',5.5)+'</g>';
 const fringe=[
 'M50 119Q39 89 64 62Q101 25 147 35Q183 39 193 76L190 112Q185 84 169 65Q141 97 92 97Q81 98 78 111L70 126L65 121Q57 113 50 119Z',
 'M49 119Q41 87 66 63Q99 34 145 37Q183 36 195 69L195 112Q184 88 168 77Q149 91 123 85Q131 81 135 77Q111 88 95 79Q86 101 76 107L70 126L64 120Q57 114 49 119Z',
 'M47 121Q35 93 61 60Q95 28 141 32Q182 32 198 73L197 115Q188 86 172 65Q144 94 95 96Q90 112 78 126L68 121Q56 111 47 121Z',
 'M49 120Q40 88 66 66Q102 36 145 40Q181 38 196 74L196 114L183 98Q164 105 152 88Q136 108 117 91Q99 110 83 101L72 124L65 120Q58 115 49 120Z',
 'M48 119Q39 86 67 61Q102 31 148 36Q185 40 197 76L194 119L180 112L175 84Q128 94 83 86L76 121L68 124Q56 113 48 119Z',
 'M49 119Q42 89 67 64Q103 33 150 35Q185 40 196 76L194 116L182 103Q180 76 160 61Q142 57 125 70Q107 83 82 87L73 122L65 121Q57 114 49 119Z',
 'M49 120Q39 86 68 62Q99 34 151 36Q185 41 197 76L194 119L181 109Q181 89 171 80L171 97Q148 88 143 65Q128 70 132 96Q110 92 105 77Q104 95 85 108L72 125L64 120Q57 114 49 120Z',
 'M48 120Q40 88 66 65Q103 35 149 38Q183 40 197 77L194 118L183 104Q181 84 166 73Q146 91 125 82Q108 104 82 100L73 124L64 120Q57 114 48 120Z'];
 fringe.push('M42 119Q31 86 57 61Q96 30 149 35Q194 37 211 78L208 120Q194 111 184 125L176 99Q158 108 143 97Q126 110 110 99Q94 110 81 101L71 124Q57 110 42 119Z',
 'M43 121Q34 89 59 63Q97 32 148 37Q191 40 208 78L205 122L188 115L180 98Q168 111 155 98Q142 111 129 98Q116 113 103 100Q90 112 79 105L69 124Q55 113 43 121Z');
 out+='<g data-part="hair-front">'+hairPath(fringe[t.hair])+'</g>';
 if(t.hair===8||t.hair===9)out+=path('M52 79Q47 70 56 65M81 47Q90 39 97 46M121 34Q131 28 137 36M173 49Q184 45 188 56M202 84Q210 89 204 97','none',2.5).replace(`stroke="${V3_INK}"`,'stroke="#ffffff" opacity=".12"');
 // Ear cushions remain at the shared anchors. Only the upper headband expands for fuller hair.
 if(t.accessory===2){const full=t.hair>=8,left=full?27:43,right=full?229:213,top=full?3:19;
  const arch=`M48 127Q${left} 113 ${left} 94Q${left} ${top} 128 ${top}Q${right} ${top} ${right} 94Q${right} 113 208 127`;
  out+='<g data-part="headphone-band">'+path(arch,'none',10)+path(arch,'none',4).replace(`stroke="${V3_INK}"`,`stroke="${p.accent}"`)+'</g>';
 }
 const eyes=[`<ellipse cx="105" cy="129" rx="8" ry="11" fill="${V3_INK}"/><ellipse cx="157" cy="125" rx="8" ry="11" fill="${V3_INK}"/>`,path('M95 130Q103 119 111 130M149 130Q157 119 165 130','none',5),path('M96 129H110','none',5)+`<ellipse cx="157" cy="125" rx="8" ry="11" fill="${V3_INK}"/>`,`<ellipse cx="103" cy="129" rx="6" ry="9" fill="${V3_INK}"/><ellipse cx="157" cy="129" rx="6" ry="9" fill="${V3_INK}"/>`,path('M94 124L103 130L112 124M148 124L157 130L166 124','none',5),circle(103,128,7,V3_INK,V3_INK,1)+circle(157,128,7,V3_INK,V3_INK,1)+circle(105,126,2,'white','none',0)+circle(159,126,2,'white','none',0)];
 eyes.push(path('M95 127Q104 137 113 127M149 124Q157 134 165 124','none',4),path('M97 124L104 128L98 132','none',4)+`<ellipse cx="157" cy="125" rx="7" ry="10" fill="${V3_INK}"/>`);
 // Glasses cover the eye area; avoid eyebrows or pupils poking through star/cat-eye points.
 if(t.accessory<8)out+=path('M96 111Q103 107 111 110M150 107Q157 102 164 106','none',4)+eyes[t.eyes];
 out+=path('M130 137Q126 143 132 144','none',3);
 out+=['M118 153Q132 164 146 150','M119 153Q130 157 142 151','M123 152Q130 164 137 152Z','M122 154H139','M119 151Q132 170 146 149Z','M127 153Q128 146 135 148Q141 153 136 159Q129 162 127 153Z'].map((d,i)=>i===t.mouth?path(d,i===2||i===4||i===5?V3_INK:'none',4):'').join('');
 out+=`<ellipse cx="87" cy="146" rx="9" ry="4" fill="#DC8F79" opacity=".30"/><ellipse cx="174" cy="146" rx="9" ry="4" fill="#DC8F79" opacity=".30"/>`;
 const accessories=['',
 circle(105,129,19,'none',V3_INK,4)+circle(157,125,19,'none',V3_INK,4)+path('M124 127Q131 121 138 125M85 126L69 121M176 121L190 117','none',4),
 `<g><rect x="36" y="111" width="25" height="42" rx="11" fill="${V3_INK}"/><rect x="39" y="114" width="16" height="36" rx="8" fill="${p.accent}"/><path d="M43 120v22" stroke="#FFF5DF" stroke-opacity=".55" stroke-width="2.5" stroke-linecap="round"/><rect x="55" y="118" width="7" height="28" rx="3.5" fill="${V3_INK}"/><rect x="195" y="111" width="25" height="42" rx="11" fill="${V3_INK}"/><rect x="201" y="114" width="16" height="36" rx="8" fill="${p.accent}"/><path d="M212 120v22" stroke="#FFF5DF" stroke-opacity=".55" stroke-width="2.5" stroke-linecap="round"/><rect x="194" y="118" width="7" height="28" rx="3.5" fill="${V3_INK}"/><path d="M209 151Q209 167 178 165" fill="none" stroke="${V3_INK}" stroke-width="4" stroke-linecap="round"/><rect x="166" y="161" width="15" height="8" rx="4" fill="${V3_INK}"/></g>`,
 `<g data-part="perched-hat" transform="translate(0 ${-[0,0,3,5,0,4,5,0,14,9][t.hair]}) rotate(-25 80 58)">`+
 path('M53 54V39Q53 18 76 18Q99 18 99 39V54Z','#27323A',3.5)+
 path('M53 46Q76 52 99 46V55Q76 61 53 55Z','#46535A',2)+
 `<ellipse cx="76" cy="57" rx="38" ry="8" fill="#27323A" stroke="${V3_INK}" stroke-width="3.5"/>`+
 path('M58 29Q66 21 77 23','none',2).replace(`stroke="${V3_INK}"`,'stroke="#677178"')+`</g>`,
 `<g transform="rotate(-8 128 73)">`+path('M51 76Q51 31 120 28Q181 25 199 73L198 90L51 94Z',p.accent,5)+path('M50 76Q122 64 199 74L198 94Q121 83 51 96Z',p.accent,5)+path('M69 78V89M86 76V87M104 74V86M122 74V85M140 74V85M158 75V86M177 77V88','none',2)+`<rect x="146" y="76" width="21" height="14" rx="3" fill="#F7E9D2"/>`+path('M152 86L157 80L162 86','none',2)+`</g>`,
 `<g transform="rotate(24 182 99)"><rect x="167" y="93" width="29" height="10" rx="5" fill="${p.accent}" stroke="${V3_INK}" stroke-width="2.5"/><path d="M174 98h14" stroke="#FFF4D8" stroke-width="2" stroke-linecap="round"/></g>`,
 circle(200,146,3,'#F5D381',V3_INK,1.5)+`<ellipse cx="201" cy="156" rx="7" ry="9" fill="none" stroke="${V3_INK}" stroke-width="5"/><ellipse cx="201" cy="156" rx="7" ry="9" fill="none" stroke="#D5A94D" stroke-width="3"/><path d="M197 151Q194 155 197 160" fill="none" stroke="#FCE3A0" stroke-width="1.5" stroke-linecap="round"/>`];
 // Sunglasses belong to the same small-accessories selector as the chain and hats.
 const lens='#20303C',shine='#A4C5C2';
 const arms=path('M84 124L69 119M176 121L192 116M121 126Q130 120 139 124','none',3.5);
 const sunglasses=[
  arms+path('M85 117Q102 112 121 117L119 132Q115 142 101 140Q89 139 87 130Z',lens,3)+path('M139 114Q157 109 175 114L174 128Q171 139 157 137Q143 136 141 128Z',lens,3)+path('M94 121L104 119M149 118L159 116','none',2.5).replace(`stroke="${V3_INK}"`,`stroke="${shine}"`),
  arms+path('M103 109L109 120L122 121L113 130L115 143L103 137L91 143L94 130L84 121L97 120Z',lens,3)+path('M156 106L162 117L175 118L166 127L168 140L156 134L144 140L147 127L137 118L150 117Z',lens,3)+path('M98 123L103 120M151 120L156 117','none',2).replace(`stroke="${V3_INK}"`,`stroke="${shine}"`),
  arms+path('M82 114L121 118Q125 136 108 141Q93 144 88 128Z',lens,3)+path('M137 117L178 109L174 125Q172 138 157 139Q140 139 137 117Z',lens,3)+path('M92 119L102 121M150 121L161 118','none',2.5).replace(`stroke="${V3_INK}"`,`stroke="${shine}"`)
 ];
 if(t.accessory<7)out+=accessories[t.accessory];
 if(t.accessory===7){
  // One gold chain, no pendant and no independently randomized jewelry layer.
  out+='<g data-part="gold-chain">';
  const links=[[105,190,-20],[108,197,-35],[114,203,-55],[122,207,-75],[131,208,90],[140,206,70],[148,202,50],[154,196,30],[156,189,15]];
  for(const [i,[x,y,angle]] of links.entries())out+=`<g transform="translate(${x} ${y}) rotate(${angle})"><ellipse rx="3" ry="4.8" fill="none" stroke="#765021" stroke-width="3.5"/><ellipse rx="3" ry="4.8" fill="none" stroke="#DDB453" stroke-width="2.3"/><path d="M-1.7-3Q-3-1-1.8 1" fill="none" stroke="#FFE6A1" stroke-width="1" stroke-linecap="round"/></g>`;
  out+='</g>';
 }
 if(t.accessory>=8)out+='<g data-part="sunglasses">'+sunglasses[t.accessory-8]+'</g>';
 return out+'</g></svg>';
}

// Shared v4 helpers. Every value written into SVG comes from built-in tables or finite numbers.
// Seeded PRNG (FNV-1a into a mulberry32 stream). Each namespace draws independently, so
// optional extras (eggs, names) never shift the trait draws of an existing seed.
function seededRng(ns,seed){let h=2166136261;for(const c of `${ns}${seed}`){h^=c.codePointAt(0);h=Math.imul(h,16777619);}return()=>{h+=0x6D2B79F5;let t=h;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
const v4Rng=seed=>seededRng('4:',seed);
// Mix two #RRGGBB colors; used to derive shade and highlight tones from curated base colors.
function mix(a,b,k){const n=s=>[1,3,5].map(i=>parseInt(s.slice(i,i+2),16));const x=n(a),y=n(b);return '#'+x.map((v,i)=>Math.round(v+(y[i]-v)*k).toString(16).padStart(2,'0')).join('').toUpperCase();}
const INK='#22303D';
// Outline width scales up when the avatar is drawn small so the silhouette stays readable.
function pen(lod){return lod===0?5.6:lod===1?4.6:4;}
const shape=(d,fill,stroke=INK,w=4)=>`<path d="${d}" fill="${fill}"${stroke==='none'?'':` stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`}/>`;
const line=(d,stroke,w,extra='')=>`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;

// Curated v4 tones sampled from the four built-in portraits: muted, warm, never candy.
const V4_PALETTES=[
 {name:'苔原绿',bg:'#DCE3DA',shirt:'#3F6B4E',accent:'#C9773F'},
 {name:'赤陶橙',bg:'#E9DFD4',shirt:'#B5603F',accent:'#3F6B5E'},
 {name:'莓果紫',bg:'#E5DEE3',shirt:'#6E4F68',accent:'#D2A25C'},
 {name:'海盐蓝',bg:'#DBE4E8',shirt:'#3E6E80',accent:'#D39A55'},
 {name:'暖麦黄',bg:'#EDE6D6',shirt:'#B88D3E',accent:'#4D6E66'},
 {name:'雾松灰',bg:'#DEE2DF',shirt:'#55666A',accent:'#C58A5B'},
];
const V4_SKINS=['#FCE3CE','#F4D0B0','#E2B48E','#C08E6B','#8E6450'];
const V4_HAIR=[
 {name:'墨蓝',base:'#25334A'},
 {name:'深棕',base:'#4A3428'},
 {name:'栗色',base:'#7B4A2E'},
 {name:'铜红',base:'#A65A35'},
 {name:'亚麻',base:'#C9A46A'},
 {name:'银灰',base:'#B7B8B4'},
];

// v4 hairstyles. Face spans x 68-188, skull top y 62, ears at x 58-68 / 188-198, y 118-146.
// back: silhouette behind the head. fringe: front mass drawn over the face, outlined in ink.
// strands: inner strand lines. shine: crown highlight. top: skull-hair top y (headphone band fit).
// tufts: spikes drawn behind the back mass so they break the top silhouette.
// locks: fringe strands drawn under the fringe so only their tips hang over the forehead.
// The renderer scales the head 1.15x about the chin, so nothing may rise above y 27.
const r1=n=>Math.round(n*10)/10;
// Scalloped outline for curly hair: bumps along an ellipse arc, bulging by `push`.
function scallop(cx,cy,rx,ry,from,to,n,push){
 const at=(a,k)=>[r1(cx+rx*k*Math.cos(a)),r1(cy+ry*k*Math.sin(a))];
 let d='',step=(to-from)/n;
 for(let i=0;i<=n;i++){const a=from+i*step,[x,y]=at(a,1);
  if(i===0){d+=`${x} ${y}`;continue;}const [qx,qy]=at(a-step/2,push);d+=`Q${qx} ${qy} ${x} ${y}`;}
 return d;
}
const P=Math.PI;
const curlTop=scallop(128,104,80,64,.9*P,2.1*P,11,1.15);
// Inner forehead edge: small curls hanging over the brow line, right temple to left temple.
const curlEdge='Q194 104 184 98Q178 106 170 98Q164 108 156 96Q146 106 140 94Q130 104 122 92Q114 104 104 94Q96 106 88 98Q80 108 74 100Q64 106 64 126';
const BASE=[
 {name:'波波头',ears:false,
  back:'M58 150C50 112 56 74 82 56C104 41 152 41 174 56C200 74 206 112 198 150Z',
  fringe:'M60 158C50 118 56 76 82 57C106 41 150 41 174 57C200 76 206 118 196 158C190 161 184 158 182 152C184 132 186 112 180 96C168 104 156 104 148 94C138 106 120 108 110 96C100 104 86 104 76 98C70 114 72 134 74 152C72 158 66 161 60 158Z',
  strands:'M110 96C112 80 118 68 128 60M148 94C146 80 140 70 130 62M66 120C64 134 66 146 68 154M190 120C192 134 190 146 188 154',
  shine:'M84 66C96 57 112 52 126 52'},
 {name:'碎短发',ears:true,
  back:'M62 132C54 104 58 74 76 60C80 48 94 42 104 46C112 36 128 34 138 42C150 36 166 42 170 52C186 56 198 74 196 96C200 110 198 122 194 132Z',
  fringe:'M66 112C60 88 68 66 86 56C104 46 150 44 170 54C188 64 196 84 192 110C186 100 180 92 176 84C172 94 166 100 160 102C160 92 156 84 152 80C144 92 132 98 120 98C124 92 126 86 126 80C116 90 102 96 90 96C92 90 92 86 90 82C82 92 74 100 66 112Z',
  strands:'M120 98C122 84 130 72 142 64M90 96C92 84 98 74 108 66M160 102C166 88 170 76 168 66',
  shine:'M96 58C108 52 122 50 134 52'},
 {name:'侧分大波浪',ears:true,
  back:'M60 138C50 108 54 76 76 58C98 40 156 38 180 56C202 74 206 108 196 138Z',
  fringe:'M64 120C58 92 64 68 84 56C110 40 156 40 180 56C200 70 204 100 196 128C192 112 186 100 178 92C176 100 170 106 162 108C164 98 162 90 158 84C146 96 126 102 104 100C116 94 124 86 128 78C112 88 92 94 74 96C70 104 66 112 64 120Z',
  strands:'M104 100C120 96 140 88 150 74M74 96C96 92 112 84 120 72M182 66C192 80 196 96 192 112',
  shine:'M88 62C104 52 124 48 142 50'},
 {name:'中分长发',ears:false,
  back:'M58 222C46 180 46 120 56 88C66 58 94 42 128 42C162 42 190 58 200 88C210 120 210 180 198 222Z',
  fringe:'M58 206C50 160 52 106 66 76C80 54 104 44 128 44C152 44 176 54 190 76C204 106 206 160 198 206C192 204 186 196 184 180C186 140 186 108 176 88C162 98 146 94 132 70C130 66 126 66 124 70C110 94 94 98 80 88C70 108 70 140 72 180C70 196 64 204 58 206Z',
  strands:'M76 122C74 150 76 178 68 198M180 122C182 150 180 178 188 198M124 72C112 88 98 92 86 86',
  shine:'M92 58C104 51 114 48 122 48M136 48C148 50 158 54 166 60'},
 {name:'清爽短发',ears:true,
  back:'M64 128C58 100 62 76 78 62C98 46 158 46 178 62C194 76 198 100 192 128Z',
  fringe:'M66 114C62 90 70 70 86 60C108 48 150 48 170 60C186 70 194 90 190 114C186 104 182 96 176 90C150 96 112 94 84 88C76 96 70 104 66 114Z',
  strands:'M110 92L118 76M138 94L144 78M162 92L165 80',
  shine:'M92 62C110 54 134 52 150 54'},
 {name:'丸子头',ears:true,
  back:'M64 128C58 100 62 76 78 62C98 46 158 46 178 62C194 76 198 100 192 128Z',
  fringe:'M66 118C60 92 68 70 86 58C108 46 150 46 170 58C188 70 196 92 190 118C184 104 176 94 166 88C144 98 118 100 96 94C108 90 116 84 120 78C104 86 86 92 74 96C70 104 68 110 66 118Z',
  strands:'M96 94C112 88 124 80 132 68M166 88C156 78 144 70 132 66',
  shine:'M94 60C110 52 132 50 150 54',
  bun:'M106 56C100 40 112 29 128 29C144 29 156 40 150 56Z', bunShine:'M116 40C120 35 126 33 133 34'},
 {name:'自然卷',ears:true,
  back:`M58 134L52 84Q${curlTop.slice(curlTop.indexOf('Q')+1)}L204 134Z`,
  fringe:`M64 126L52 84Q${curlTop.slice(curlTop.indexOf('Q')+1)}L194 126${curlEdge}Z`,
  strands:'M86 70q6-6 12 0M118 54q6-6 12 0M150 58q6-6 12 0M174 80q6-6 12 0M70 92q6-6 12 0',
  shine:'M100 52C112 44 128 42 140 44'},
 {name:'后梳飞机头',ears:true,
  back:'M66 130C60 104 62 80 74 66C82 50 100 40 124 38C150 34 176 44 186 62C196 80 196 104 190 130Z',
  fringe:'M68 112C64 90 70 72 82 62C92 46 112 34 136 32C160 30 182 42 188 62C194 80 192 98 188 112C184 100 178 92 170 86C154 74 130 70 108 76C94 80 80 90 74 100C70 104 68 108 68 112Z',
  strands:'M100 70C114 54 136 44 160 46M118 74C130 60 150 54 172 60',
  shine:'M96 52C110 42 126 37 142 37'},
];
// Spike from a base buried in the hair mass (x,y, half-width w) to a tip (tx,ty).
const spike=([x,y,w,tx,ty])=>`M${x-w} ${y}Q${r1(x-w*.3)} ${r1(ty+(y-ty)*.4)} ${tx} ${ty}Q${r1(x+w*.5)} ${r1(ty+(y-ty)*.5)} ${x+w} ${y}Z`;
const lock=([x,y,w,tx,ty])=>`M${x-w} ${y}Q${r1(x-w*.7)} ${r1((y+ty)/2)} ${tx} ${ty}Q${r1(x+w)} ${r1((y+ty)/2)} ${x+w} ${y}Z`;
const SHAPES=[
 {top:44,tufts:[[118,58,8,122,30],[142,58,7,158,35],[100,62,6,90,42]],locks:[[122,94,6,120,112],[134,94,5,136,109]]},
 {top:38,tufts:[[112,52,8,104,30],[136,50,8,146,28],[160,58,7,176,40]],locks:[[110,82,5,104,98],[134,86,5,132,108]]},
 {top:44,tufts:[[116,56,8,110,32],[138,56,7,152,34]],locks:[[128,88,6,124,110],[146,84,5,152,96]]},
 {top:44,tufts:[[122,56,6,112,32],[134,56,6,146,34]],locks:[[122,64,4,114,96],[134,64,4,142,96]]},
 {top:50,tufts:[[108,64,7,100,40],[128,62,8,130,36],[150,64,7,162,42]],locks:[[112,86,5,108,96],[128,88,6,128,110],[146,86,5,152,96]]},
 {top:50,tufts:[[96,64,6,86,46],[162,64,6,172,46]],locks:[[126,90,6,124,110],[142,88,5,150,96]]},
 {top:36,tufts:[[112,48,6,106,28],[146,48,6,156,30]],locks:[[128,92,5,126,108]]},
 {top:32,tufts:[[128,46,7,146,28],[150,46,8,170,31],[176,56,6,190,42]],locks:[[132,66,5,122,94]]},
];
const V4_HAIRSTYLES=BASE.map((s,i)=>Object.freeze({...s,top:SHAPES[i].top,tufts:SHAPES[i].tufts.map(spike).join(''),locks:SHAPES[i].locks.map(lock).join('')}));

// v4 head: ears, face, neck and features. Features use ink only; no outlines inside the face.
const V4_FACE='M68 104C68 76 94 62 128 62C162 62 188 76 188 104L188 128C188 160 162 182 128 182C94 182 68 160 68 128Z';
const V4_NECK='M110 166L110 196C120 204 136 204 146 196L146 166Z';
function v4Ears(skin,lod,w){
 const ear=(d,inner)=>shape(d,skin,INK,w)+(lod===0?line(inner,mix(skin,'#9A5A44',.45),2.4):'');
 return ear('M72 118C62 112 54 118 56 130C58 142 64 148 74 146Z','M66 124C62 128 63 136 68 140')+
  ear('M184 118C194 112 202 118 200 130C198 142 192 148 182 146Z','M190 124C194 128 193 136 188 140');
}
// Eyes sit at (106,130) and (150,130): large dark ovals like the built-ins, one catchlight
// upper-right and a short upper-lid stroke. Only friendly expressions; no lidded or sleepy eyes.
const EL=106,ER=150,EY=130;
const oval=(x,rx,ry)=>`<ellipse cx="${x}" cy="${EY}" rx="${rx}" ry="${ry}" fill="${INK}"/>`;
const glint=(x,lod,r,dy=4.5)=>lod===2?'':`<circle cx="${x+3.4}" cy="${EY-dy}" r="${r}" fill="#FFFFFF"/>`;
const lid=x=>`M${x-9} ${EY-9}C${x-6} ${EY-15} ${x+4} ${EY-16} ${x+10} ${EY-11}`;
const V4_EYES=[
 {name:'亮眼睛',draw:lod=>oval(EL,8.5,11)+oval(ER,8.5,11)+glint(EL,lod,lod===0?2.8:3.2)+glint(ER,lod,lod===0?2.8:3.2)+line(lid(EL)+lid(ER),INK,3.4)},
 {name:'笑眯眯',draw:()=>line(`M${EL-10} ${EY+3}C${EL-6} ${EY-9} ${EL+6} ${EY-9} ${EL+10} ${EY+3}M${ER-10} ${EY+3}C${ER-6} ${EY-9} ${ER+6} ${EY-9} ${ER+10} ${EY+3}`,INK,5.2)},
 {name:'圆眼睛',draw:lod=>oval(EL,9,9.5)+oval(ER,9,9.5)+glint(EL,lod,lod===0?3:3.4,3.5)+glint(ER,lod,lod===0?3:3.4,3.5)},
];
const V4_BROWS=[
 {name:'柔和',d:'M96 108C101 104 108 103 114 105M142 105C148 103 155 104 160 108'},
 {name:'平直',d:'M96 106L114 104M142 104L160 106'},
 {name:'上扬',d:'M97 109C102 103 108 101 115 101M141 101C148 101 154 103 159 109'},
];
// Every mouth smiles; flat, pursed and downturned shapes are excluded on purpose.
const V4_MOUTHS=[
 {name:'微笑',draw:()=>line('M117 152C123 159 133 159 139 152',INK,4.2)},
 {name:'开心',draw:()=>shape('M115 150C120 151 136 151 141 150C140 160 134 165 128 165C122 165 116 160 115 150Z',INK,INK,3)+shape('M121 160C125 157 131 157 135 160C133 163 130 164 128 164C126 164 123 163 121 160Z','#D9786A','none')},
 {name:'坏笑',draw:()=>line('M117 153C123 158 132 158 139 150',INK,4.2)},
];
function v4Features(t,skin,lod,hideBrows){
 let s='';
 // Soft cheek warmth and a tiny nose hook, dropped at icon sizes.
 if(lod<2)s+=`<ellipse cx="92" cy="148" rx="9" ry="5" fill="#E88F7A" opacity=".26"/><ellipse cx="164" cy="148" rx="9" ry="5" fill="#E88F7A" opacity=".26"/>`;
 if(lod<2)s+=line('M129 136C127 140 127 142 131 143',mix(skin,'#7A4636',.55),2.8);
 if(!hideBrows)s+=line(V4_BROWS[t.brows].d,INK,lod===2?5:4.2);
 s+=V4_EYES[t.eyes].draw(lod)+V4_MOUTHS[t.mouth].draw(lod);
 return s;
}

// v4 garments. Body is cropped by the canvas bottom like the built-ins; only collars carry detail.
const V4_BODY='M110 188C84 190 56 198 42 216C32 228 28 246 27 262L229 262C228 246 224 228 214 216C200 198 172 190 146 188Z';
const crew='M106 189C114 206 142 206 150 189';
const rib='M104 188C112 210 144 210 152 188L146 186C140 200 116 200 110 186Z';
// Small ink folds near the armpits suggest arms against the torso.
const folds='M64 230C68 240 70 250 70 262M192 230C188 240 186 250 186 262';
const V4_OUTFITS=[
 {name:'圆领卫衣',draw:(p,w,lod)=>shape(rib,mix(p.shirt,'#000000',.15),INK,w*.75)+(lod<2?line('M86 196C80 210 76 226 74 240M170 196C176 210 180 226 182 240',mix(p.shirt,'#000000',.28),2.6):'')},
 {name:'翻领衬衫',draw:(p,w,lod)=>{const c=mix(p.shirt,'#FFFFFF',.82);return shape('M110 187L128 210L146 187Z',mix(p.shirt,'#000000',.25),'none')+line('M128 210V262',INK,w*.6)+shape('M108 184L128 210L106 214L96 196Z',c,INK,w*.75)+shape('M148 184L128 210L150 214L160 196Z',c,INK,w*.75)+(lod<2?`<circle cx="132" cy="226" r="2.4" fill="${c}"/><circle cx="132" cy="244" r="2.4" fill="${c}"/>`:'')}},
 {name:'开衫',draw:(p,w,lod)=>{const tee=mix(p.accent,'#FFFFFF',.55);return shape('M108 188L148 188L140 262L116 262Z',tee,INK,w*.75)+line(crew,INK,w*.6)+line('M108 188C112 214 116 238 116 262M148 188C144 214 140 238 140 262',INK,w*.75)+(lod<2?`<circle cx="145" cy="222" r="2.6" fill="${INK}"/><circle cx="143" cy="242" r="2.6" fill="${INK}"/>`:'')}},
 {name:'西装外套',draw:(p,w)=>{const tee=mix(p.shirt,'#FFFFFF',.85),lap=mix(p.shirt,'#000000',.18);return shape('M108 188L148 188L136 262L120 262Z',tee,INK,w*.75)+line(crew,INK,w*.6)+shape('M108 186L98 202L108 208L104 216L124 262L110 262L92 222L90 198Z',lap,INK,w*.75)+shape('M148 186L158 202L148 208L152 216L132 262L146 262L164 222L166 198Z',lap,INK,w*.75)}},
 {name:'连帽衫',draw:(p,w,lod)=>{const hood=mix(p.shirt,'#000000',.16),inner=mix(p.shirt,'#000000',.38);return shape('M92 196C84 186 96 176 110 180L128 206L146 180C160 176 172 186 164 196C156 214 140 222 128 222C116 222 100 214 92 196Z',hood,INK,w*.75)+shape('M110 184L128 206L146 184C140 196 116 196 110 184Z',inner,'none')+(lod<2?line('M118 214V236M138 214V236',mix(p.accent,'#FFFFFF',.4),3)+`<circle cx="118" cy="238" r="2.6" fill="${mix(p.accent,'#FFFFFF',.4)}"/><circle cx="138" cy="238" r="2.6" fill="${mix(p.accent,'#FFFFFF',.4)}"/>`:'')}},
 {name:'高领毛衣',draw:(p,w,lod)=>{const c=mix(p.shirt,'#000000',.12);return shape('M106 168C106 162 150 162 150 168L152 196C140 206 116 206 104 196Z',c,INK,w*.75)+(lod<2?line('M114 172V198M122 172V202M130 172V202M138 172V202M146 172V198',mix(p.shirt,'#000000',.32),2):'')}},
 {name:'T 恤',draw:(p,w,lod)=>shape(rib,mix(p.shirt,'#FFFFFF',.2),INK,w*.75)+(lod<2?shape('M160 220H184V236C178 242 166 242 160 236Z','none',mix(p.shirt,'#000000',.32),2.6):'')},
];
const V4_FOLDS=folds;

// v4 accessories: a short list that reads at 32 px. Each returns markup for its layer.
const lens=(x,y,round)=>round?`<circle cx="${x}" cy="${y}" r="15" fill="#FFFFFF" fill-opacity=".18" stroke="${INK}" stroke-width="3.6"/>`:`<rect x="${x-16}" y="${y-14}" width="32" height="28" rx="9" fill="#FFFFFF" fill-opacity=".18" stroke="${INK}" stroke-width="3.6"/>`;
function glasses(round){return '<g data-part="glasses">'+lens(106,130,round)+lens(150,130,round)+line('M121 128C125 124 131 124 135 128M90 126L70 122M166 126L186 122',INK,3.4)+'</g>';}
// Headphone band over the skull top; shared with the music eggs so both sit on the same arc.
function v4PhoneBand(style){const top=Math.max(style.top-10,26);return `M60 122C50 ${top+40} 80 ${top} 128 ${top}C176 ${top} 206 ${top+40} 196 122`;}
const V4_ACCESSORIES=['无','圆框眼镜','方框眼镜','耳机','毛线帽','围巾','发夹'];
// Layer "front": drawn after the fringe. Layer "neck": drawn over the garment, under the face.
function v4Accessory(t,p,style,w,lod){
 const a=t.accessory,out={neck:'',front:''};
 if(a===1||a===2)out.front=glasses(a===1);
 if(a===3){const band=v4PhoneBand(style);
  out.front='<g data-part="headphones">'+line(band,INK,10)+line(band,p.accent,5)+
   `<rect x="46" y="112" width="20" height="40" rx="10" fill="${p.accent}" stroke="${INK}" stroke-width="${w}"/><rect x="190" y="112" width="20" height="40" rx="10" fill="${p.accent}" stroke="${INK}" stroke-width="${w}"/>`+
   (lod<2?line('M52 122V142M204 122V142',mix(p.accent,'#FFFFFF',.45),2.6):'')+'</g>';}
 if(a===4){const knit=mix(p.accent,'#000000',.08),cuff=mix(p.accent,'#000000',.2);
  out.front='<g data-part="beanie">'+shape('M62 98C60 62 90 42 128 42C166 42 196 62 194 98Z',knit,INK,w)+
   (lod<2?line('M96 54C92 66 92 78 94 92M128 44V92M160 54C164 66 164 78 162 92',mix(p.accent,'#000000',.24),2.4):'')+
   shape('M58 88C90 80 166 80 198 88L198 102C166 94 90 94 58 102Z',cuff,INK,w)+
   `<circle cx="128" cy="38" r="9" fill="${knit}" stroke="${INK}" stroke-width="${w}"/></g>`;}
 if(a===5){const c=p.accent,d=mix(c,'#000000',.2);
  out.neck='<g data-part="scarf">'+shape('M100 182C112 196 144 196 156 182L166 196C150 214 106 214 90 196Z',c,INK,w)+
   shape('M136 202L156 206L150 246L134 242Z',d,INK,w*.8)+(lod<2?line('M138 228L151 231',mix(c,'#FFFFFF',.35),2.4):'')+'</g>';}
 if(a===6)out.front='<g data-part="hair-clip" transform="rotate(-28 166 86)">'+`<rect x="152" y="80" width="30" height="11" rx="5.5" fill="${p.accent}" stroke="${INK}" stroke-width="3"/>`+(lod<2?line('M159 85.5H175',mix(p.accent,'#FFFFFF',.5),2.2):'')+'</g>';
 return out;
}

// v4 easter eggs: rare, gently animated extras. Opt-in only ({ eggs: true }); without it the
// renderer output is byte-identical. The egg comes from its own seed namespace, so it never
// shifts trait draws. Rest poses are the static markup: renderers that skip CSS animation, PNG
// export and prefers-reduced-motion all show the decoration standing still.
const eggR2=n=>Math.round(n*100)/100;
// Wrapper places a part; the inner group animates about the wrapper's local origin.
const eggAt=(transform,cls,body)=>`<g transform="${transform}"><g class="fa-m ${cls}">${body}</g></g>`;
const eggPath=(d,fill,w)=>`<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
// Every animation delay is offset by --fa-t, so a frame sampler can pause the clock at any time.
const eggDelay=s=>`animation-delay:calc(${s}s - var(--fa-t, 0s))`;
const eggAnim=(sel,spec,delay=0)=>`${sel}{animation:${spec};${eggDelay(delay)}}`;
const STAR4=s=>{const a=eggR2(s*.16),b=eggR2(s*.3);return `M0 ${-s}C${a} ${-b} ${b} ${-a} ${s} 0C${b} ${a} ${a} ${b} 0 ${s}C${-a} ${b} ${-b} ${a} ${-s} 0C${-b} ${-a} ${-a} ${-b} 0 ${-s}Z`;};
const STAR5=(()=>{let d='';for(let i=0;i<10;i++){const r=i%2?5.4:12,a=Math.PI*(i/5-.5);d+=(i?'L':'M')+eggR2(r*Math.cos(a))+' '+eggR2(r*Math.sin(a));}return d+'Z';})();
const LEAF='M0 -10C8 -8 10 2 0 11C-10 2 -8 -8 0 -10Z';
const CLOUD='M-18 6C-25 6 -25 -5 -16 -5C-15 -13 -4 -15 1 -8C5 -14 17 -12 16 -4C24 -4 24 6 16 6Z';
const HEART='M0 5C-9 -1 -10 -8 -5.5 -10C-2.5 -11.3 0 -9 0 -6.5C0 -9 2.5 -11.3 5.5 -10C10 -8 9 -1 0 5Z';
const AHOGE='M0 4C-4 -10 2 -24 14 -28C22 -30 24 -22 17 -19';
// Music eggs: over-ear cups centred on the ears (head frame), on the same band as the accessory.
const CUPS=[56,200];
const musicCup=(x,cls,fill,w,extra='')=>eggAt(`translate(${x} 132)`,cls,`<rect x="-12" y="-22" width="24" height="44" rx="12" fill="${fill}" stroke="${INK}" stroke-width="${w}"/>`+extra);
const NOTE1=`<ellipse cx="0" cy="0" rx="4.6" ry="3.4" transform="rotate(-22)" fill="${INK}"/>`+line('M4 -1V-17C9 -15 11 -11 9 -7',INK,2.6);
const NOTE2=`<ellipse cx="0" cy="0" rx="4.6" ry="3.4" transform="rotate(-22)" fill="${INK}"/><ellipse cx="11" cy="-3" rx="4.6" ry="3.4" transform="rotate(-22 11 -3)" fill="${INK}"/>`+line('M4 -1V-16M15 -4V-19',INK,2.6)+`<path d="M4 -17L15 -20L15 -15.5L4 -12.5Z" fill="${INK}"/>`;
// The music eggs move the whole head. :has() scopes the rule to the SVG that carries the egg,
// because an inline <style> applies to the whole page. Without :has() the head simply stays still.
const headAnim=(id,spec)=>eggAnim(`svg:has([data-egg="${id}"]) [data-part="head"]`,spec);
const stillHead='svg [data-part="head"]{animation:none!important}';
// Slots: bg (behind the character), neck (over the garment, under the face), face (over the face,
// under the fringe, head frame), head (over head-worn accessories, head frame), over (canvas top).
// `loop` is the seconds after which every part of the egg repeats; GIF export samples one loop.
const V4_EGGS=[
 {id:'blink',name:'眨眨眼',en:'Blink',slot:'face',loop:4.8,
  css:'@keyframes fa-blink{0%,88%,100%{opacity:0}90%,95%{opacity:1}}'+eggAnim('.fa-blink','fa-blink 4.8s infinite'),
  // Reduced motion keeps a still wink instead of a blink.
  still:'.fa-wink{opacity:1}',
  draw:({skin})=>{const lid=x=>`<ellipse cx="${x}" cy="129" rx="12.5" ry="13.5" fill="${skin}"/>`+line(`M${x-9} 131C${x-5} 136 ${x+5} 136 ${x+9} 131`,INK,4.2);
   return `<g class="fa-m fa-blink" opacity="0">${lid(106)}</g><g class="fa-m fa-blink fa-wink" opacity="0">${lid(150)}</g>`;}},
 {id:'sparkle',name:'闪闪亮',en:'Sparkle',slot:'over',loop:2.4,
  css:'@keyframes fa-tw{0%,100%{transform:scale(1) rotate(0deg)}50%{transform:scale(.55) rotate(45deg)}}'+eggAnim('.fa-tw','fa-tw 2.4s ease-in-out infinite')+`.fa-tw2{${eggDelay(-1.2)}}`,
  draw:({p})=>{const c=mix(p.accent,'#FFFFFF',.6);return eggAt('translate(212 50)','fa-tw',eggPath(STAR4(21),c,3))+eggAt('translate(236 88)','fa-tw fa-tw2',eggPath(STAR4(11),c,2.6))+eggAt('translate(190 24)','fa-tw fa-tw2',eggPath(STAR4(8),c,2.4));}},
 {id:'leaf',name:'落叶飘飘',en:'Falling leaf',slot:'bg',loop:10,
  css:'@keyframes fa-leaf{0%{transform:translate(0px,0px) rotate(0deg);opacity:0}6%{opacity:1}25%{transform:translate(12px,58px) rotate(50deg)}50%{transform:translate(-8px,118px) rotate(-15deg)}75%{transform:translate(10px,178px) rotate(40deg);opacity:1}100%{transform:translate(0px,236px) rotate(0deg);opacity:0}}'+eggAnim('.fa-leaf','fa-leaf 10s linear infinite',-1)+`.fa-leaf2{${eggDelay(-6)}}`,
  draw:({p})=>{const leaf=eggPath(LEAF,p.accent,2.2)+line('M0 -6V7',mix(p.accent,'#000000',.3),1.6);return eggAt('translate(26 30) rotate(-20) scale(1.6)','fa-leaf',leaf)+eggAt('translate(230 20) rotate(25) scale(1.5)','fa-leaf fa-leaf2',leaf);}},
 {id:'star',name:'小星星',en:'Little star',slot:'over',loop:3.2,
  css:'@keyframes fa-bob{0%,100%{transform:translate(0px,0px) rotate(-8deg)}50%{transform:translate(0px,-7px) rotate(8deg)}}'+eggAnim('.fa-bob','fa-bob 3.2s ease-in-out infinite'),
  draw:({p})=>eggAt('translate(34 56) scale(1.7)','fa-bob',eggPath(STAR5,mix(p.accent,'#FFFFFF',.45),2.4)+`<circle cx="-2.6" cy="0.6" r="1.3" fill="${INK}"/><circle cx="2.6" cy="0.6" r="1.3" fill="${INK}"/>`)},
 {id:'ahoge',name:'呆毛',en:'Cowlick',slot:'head',loop:2.6,
  // A crown strand drawn over the hair; a borderless hair-colour dab hides the root cap.
  // Scaled so its tip never rises above head y 27.
  fits:(t,style)=>t.accessory!==4&&!style.bun&&style.top>=36,
  css:'@keyframes fa-sway{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(9deg)}}'+eggAnim('.fa-sway','fa-sway 2.6s ease-in-out infinite'),
  draw:({hc,style})=>{const k=Math.min(1,eggR2((style.top+10-27)/30));return eggAt(`translate(130 ${style.top+10}) scale(${k})`,'fa-sway',line(AHOGE,INK,9)+line(AHOGE,hc,4.6)+`<circle cx="0" cy="4" r="4.6" fill="${hc}"/>`);}},
 {id:'clouds',name:'云朵慢游',en:'Drifting clouds',slot:'bg',loop:12,
  css:'@keyframes fa-drift{0%,100%{transform:translate(0px,0px)}50%{transform:translate(16px,2px)}}'+eggAnim('.fa-drift','fa-drift 12s ease-in-out infinite')+'.fa-drift2{animation-direction:reverse}',
  draw:()=>{const cloud=`<path d="${CLOUD}" fill="#FFFFFF" fill-opacity=".72"/>`;return eggAt('translate(44 46) scale(1.5)','fa-drift',cloud)+eggAt('translate(214 30) scale(1.15)','fa-drift fa-drift2',cloud)+eggAt('translate(228 118) scale(.9)','fa-drift',cloud);}},
 {id:'tophat',name:'迷你礼帽',en:'Tiny top hat',slot:'head',loop:2.2,
  fits:t=>t.accessory!==3&&t.accessory!==4,
  css:'@keyframes fa-wob{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(7deg)}}'+eggAnim('.fa-wob','fa-wob 2.2s ease-in-out infinite'),
  draw:({p,style})=>{const k=Math.min(1.5,eggR2((style.top+16-29)/19)),dark=mix(p.shirt,'#000000',.45);
   return eggAt(`translate(164 ${style.top+16}) rotate(18) scale(${k})`,'fa-wob',eggPath('M-8 0L-7 -16C-7 -19 7 -19 7 -16L8 0Z',dark,2.8)+`<path d="M-7.6 -6L7.6 -6L7.9 -1.5L-7.9 -1.5Z" fill="${p.accent}"/>`+eggPath('M-14 0C-14 -3.5 14 -3.5 14 0C14 3.5 -14 3.5 -14 0Z',dark,2.8));}},
 {id:'hearts',name:'冒爱心',en:'Floating hearts',slot:'over',loop:3.4,
  css:'@keyframes fa-rise{0%{transform:translate(0px,0px) scale(.7);opacity:0}15%{opacity:1}70%{opacity:1}100%{transform:translate(4px,-40px) scale(1.1);opacity:0}}'+eggAnim('.fa-rise','fa-rise 3.4s ease-out infinite',-1.4)+`.fa-rise2{${eggDelay(-2.6)}}`,
  draw:()=>eggAt('translate(222 150) scale(1.6)','fa-rise',eggPath(HEART,'#E88F7A',2))+eggAt('translate(36 172) scale(1.25)','fa-rise fa-rise2',eggPath(HEART,'#E88F7A',2.2))},
 // Hip-hop: a firm nod with a short snap at 100 bpm, thumping cups, equaliser bars and a chain.
 // Replaces the plain headphones accessory (same band, bigger cups); skipped under a beanie.
 {id:'hiphop',name:'嘻哈节拍',en:'Hip-hop beat',slot:'head',loop:2.4,
  fits:t=>t.accessory!==4,
  css:'@keyframes fa-nod{0%,100%{translate:0px 0px}12%{translate:0px 4px}30%{translate:0px 0px}}'+headAnim('hiphop','fa-nod .6s cubic-bezier(.2,.9,.3,1) infinite')+
   '@keyframes fa-thump{0%,100%{transform:scale(1)}12%{transform:scale(1.1)}35%{transform:scale(1)}}'+eggAnim('.fa-thump','fa-thump .6s ease-out infinite')+
   '@keyframes fa-eq{0%,100%{transform:scaleY(.35)}12%{transform:scaleY(1)}45%{transform:scaleY(.55)}}'+eggAnim('.fa-eq','fa-eq .6s ease-out infinite')+`.fa-eq2{${eggDelay(-.15)}}.fa-eq3{${eggDelay(-.3)}}`,
  still:stillHead,
  draw:({p,t,style,w})=>{
   const dark=mix(INK,'#000000',.15),gold='#D2A25C',band=v4PhoneBand(style);
   const ring='<rect x="-6.5" y="-14" width="13" height="28" rx="6.5" fill="none" stroke="'+gold+'" stroke-width="2.6"/>';
   const bar=(x,y,h,k)=>eggAt(`translate(${x} ${y})`,'fa-eq'+(k?' fa-eq'+k:''),`<rect x="-3.2" y="${-h}" width="6.4" height="${h}" rx="2" fill="${p.accent}" stroke="${INK}" stroke-width="2.2"/>`);
   return {
    head:line(band,INK,11)+line(band,dark,6)+CUPS.map(x=>musicCup(x,'fa-thump',dark,w,ring)).join(''),
    // The chain is dropped when a scarf already wraps the neck.
    neck:t.accessory===5?'':line('M104 196C112 214 144 214 152 196',INK,6.4)+`<path d="M104 196C112 214 144 214 152 196" fill="none" stroke="${gold}" stroke-width="3.4" stroke-dasharray="4.5 2.5" stroke-linecap="round"/>`,
    over:bar(214,62,16,0)+bar(224,62,28,2)+bar(234,62,20,3)+bar(22,68,20,3)+bar(32,68,28,2)+bar(42,68,16,0)};}},
 // Pop: a light side-to-side sway about the chin, bouncing pastel cups with a sparkle, notes in arcs.
 {id:'pop',name:'流行小调',en:'Pop tune',slot:'head',loop:2,
  fits:t=>t.accessory!==4,
  // Rotating about the chin (128,182) with translate compensating, so the neck joint stays put.
  css:'@keyframes fa-groove{0%,50%,100%{rotate:0deg;translate:0px 0px}25%{rotate:3deg;translate:9.7px -6.45px}75%{rotate:-3deg;translate:-9.35px 6.95px}}'+headAnim('pop','fa-groove 2s ease-in-out infinite')+
   '@keyframes fa-bounce{0%,100%{transform:scale(1)}20%{transform:scale(1.06)}}'+eggAnim('.fa-bounce','fa-bounce .5s ease-out infinite')+
   '@keyframes fa-float{0%{transform:translate(0px,0px) rotate(-8deg) scale(.7);opacity:0}15%{opacity:1}50%{transform:translate(8px,-18px) rotate(8deg) scale(1)}100%{transform:translate(-2px,-38px) rotate(-6deg) scale(1);opacity:0}}'+
   '@keyframes fa-float2{0%{transform:translate(0px,0px) rotate(8deg) scale(.7);opacity:0}15%{opacity:1}50%{transform:translate(-8px,-18px) rotate(-8deg) scale(1)}100%{transform:translate(2px,-38px) rotate(6deg) scale(1);opacity:0}}'+
   eggAnim('.fa-float','fa-float 2s ease-in-out infinite',-.6)+eggAnim('.fa-float2','fa-float2 2s ease-in-out infinite',-1.4)+`.fa-float3{${eggDelay(-1.6)}}`,
  still:stillHead,
  draw:({p,style,w})=>{
   const soft=mix(p.accent,'#FFFFFF',.35),band=v4PhoneBand(style);
   const sparkle=`<path d="${STAR4(6)}" fill="#FFFFFF"/>`;
   return {
    head:line(band,INK,10)+line(band,soft,5)+CUPS.map(x=>musicCup(x,'fa-bounce',soft,w,sparkle)).join(''),
    over:eggAt('translate(222 110) scale(1.4)','fa-float',NOTE1)+eggAt('translate(24 116) scale(1.4)','fa-float2',NOTE2)+eggAt('translate(230 160) scale(1.1)','fa-float fa-float3',NOTE2)};}},
];
// Each egg owns an equal slice of the seed space. The first eight keep the draw they were
// released with (a second random pick among them); eggs added later take new slices above it,
// so a seed that already showed an egg keeps it.
const EGG_SLICE=0.0125,FIRST_EGGS=8;
const V4_EGG_RATE=Math.round(V4_EGGS.length*EGG_SLICE*1e6)/1e6;
function v4EggIndex(seed){
 const random=seededRng('egg:',String(seed)),r=random();
 if(r<FIRST_EGGS*EGG_SLICE)return Math.floor(random()*FIRST_EGGS);
 const i=Math.floor(r/EGG_SLICE);return i<V4_EGGS.length?i:-1;
}
// An egg that does not fit the final traits (a cowlick under a beanie) yields to the next one.
// `clash` lets a render version rule out eggs for parts only it has.
function v4PickEgg(index,t,style,clash){
 if(!(index>=0))return null;
 for(let k=0;k<V4_EGGS.length;k++){const e=V4_EGGS[(index+k)%V4_EGGS.length];if((!e.fits||e.fits(t,style))&&!(clash&&clash(e)))return e;}
 return null;
}
// `force` names an egg id to draw regardless of the seed (previews, tests).
function v4ResolveEgg(seed,t,style,force,clash){const i=V4_EGGS.findIndex(x=>x.id===force);return v4PickEgg(i>=0?i:v4EggIndex(seed),t,style,clash);}
// animate=false keeps the decoration but drops every animation: the still pose that reduced motion
// shows (a wink instead of a blink), for hosts whose own motion setting cannot reach inside an <img>.
function v4EggMarkup(egg,ctx,animate=true){
 const out={defs:'',bg:'',neck:'',face:'',head:'',over:''};
 if(!egg)return out;
 const stillCss=(egg.still||'').replace(stillHead,'');
 out.defs=animate?`<style>.fa-m{transform-box:view-box;transform-origin:0 0}${egg.css}@media (prefers-reduced-motion:reduce){.fa-m{animation:none!important}${egg.still||''}}</style>`:stillCss?`<style>${stillCss}</style>`:'';
 const drawn=egg.draw(ctx),parts=typeof drawn==='string'?{[egg.slot]:drawn}:drawn;
 for(const [slot,markup] of Object.entries(parts))if(markup)out[slot]=`<g data-egg="${egg.id}">${markup}</g>`;
 return out;
}
// One still frame of an animated avatar at `seconds` into its loop: every animation is paused and
// its clock offset through --fa-t. SVGs without egg styles come back unchanged.
function v4FreezeFrame(svg,seconds){
 const t=Number.isFinite(seconds)?Math.round(seconds*1000)/1000:0;
 return String(svg).replace('<style>',`<style>svg{--fa-t:${t}s}svg *{animation-play-state:paused!important}`);
}

// v4 renderer: assembles layers back to front. Seed is only hashed; no input reaches the markup.
// 1.15x about (128,182): head fills ~55% of the tile width and sits higher.
const HEAD='matrix(1.15 0 0 1.15 -19.2 -27.3)';
const V4_OPTIONS=Object.freeze({palette:V4_PALETTES.length,skin:V4_SKINS.length,hairColor:V4_HAIR.length,hair:V4_HAIRSTYLES.length,eyes:V4_EYES.length,brows:V4_BROWS.length,mouth:V4_MOUTHS.length,outfit:V4_OUTFITS.length,accessory:V4_ACCESSORIES.length});
const V4_COMBINATIONS=Object.values(V4_OPTIONS).reduce((a,b)=>a*b,1);
function getTraitsV4(seed='fuli',overrides={}){const random=v4Rng(String(seed)),o=overrides&&typeof overrides==='object'?overrides:{};return Object.fromEntries(Object.entries(V4_OPTIONS).map(([key,count])=>{const value=o[key],sample=Math.floor(random()*count);return[key,Number.isInteger(value)&&value>=0&&value<count?value:sample];}));}
// The easter egg { eggs: true } would draw for this seed and traits, or null.
function getEggV4(seed='fuli',overrides={}){const t=getTraitsV4(seed,overrides);return v4ResolveEgg(seed,t,V4_HAIRSTYLES[t.hair]);}
function createAvatarV4(seed='fuli',config={}){
 const c=config&&typeof config==='object'?config:{},t=getTraitsV4(seed,c.traits);
 return composeAvatar(seed,c,t,{id:'v4',palette:V4_PALETTES[t.palette],outfit:V4_OUTFITS[t.outfit].draw,accessory:v4Accessory});
}
// Layer assembly shared by render versions 4 and 5. `look` supplies the version's clip id, colours
// ({ bg, shirt, accent }), garment detail drawer and accessory drawer, plus optional eggClash and
// mark (v5); everything else is common, so v4 output stays byte-identical.
function composeAvatar(seed,c,t,look){
 const size=Number.isInteger(c.size)&&c.size>=16&&c.size<=4096?c.size:256;
 // Level of detail: 0 full, 1 medium (≤96 px), 2 icon (≤48 px). Fine lines drop out as size shrinks.
 const lod=size<=48?2:size<=96?1:0,w=pen(lod);
 const p=look.palette,skin=V4_SKINS[t.skin],hc=V4_HAIR[t.hairColor].base,style=V4_HAIRSTYLES[t.hair];
 const light=t.hairColor>=4,beanie=t.accessory===4;
 const rounded=c.rounded!==false,rx=rounded?36:0;
 // Eggs are opt-in: without `eggs: true` or a known `egg` id every slot is empty and output is unchanged.
 const wantsEgg=c.eggs===true||V4_EGGS.some(e=>e.id===c.egg);
 const egg=v4EggMarkup(wantsEgg?v4ResolveEgg(seed,t,style,c.egg,look.eggClash):null,{p,skin,hc,style,t,w},c.animate!==false);
 const mark=look.mark?look.mark(lod):{frame:'',chest:'',lens:''};
 const strand=mix(hc,light?'#5A4630':'#FFFFFF',light?.35:.16),shine=mix(hc,'#FFFFFF',light?.6:.38);
 let s=`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-label="Generated FULI avatar">`;
 s+=`<defs><clipPath id="fuli-avatar-${look.id}-${rounded?'r':'s'}"><rect width="256" height="256" rx="${rx}"/></clipPath>${egg.defs}</defs>`;
 s+=`<rect width="256" height="256" rx="${rx}" fill="${c.transparent?'none':p.bg}"/>`;
 s+=`<g data-part="portrait" clip-path="url(#fuli-avatar-${look.id}-${rounded?'r':'s'})">`+egg.bg+mark.frame;
 const hairShape=d=>shape(d,hc,INK,w);
 // Head, hair and head-worn pieces share one frame scaled about the chin so the neck joint stays put.
 const head=`<g data-part="head" transform="${HEAD}">`;
 let back='';
 if(!beanie)back+=hairShape(style.tufts);
 if(style.bun&&!beanie)back+=hairShape(style.bun)+(lod<2?line(style.bunShine,shine,3,' opacity=".8"'):'');
 back+=hairShape(style.back);
 s+=head+'<g data-part="hair-back">'+back+'</g></g>';
 s+='<g data-part="neck">'+shape(V4_NECK,skin,INK,w)+shape('M110 180C118 190 138 190 146 180L146 190C138 196 118 196 110 190Z',mix(skin,'#9A5A44',.22),'none')+'</g>';
 s+=`<g data-part="outfit" data-style="${t.outfit}">`+shape(V4_BODY,p.shirt,INK,w)+(lod<2?line(V4_FOLDS,mix(p.shirt,'#000000',.3),2.6):'')+look.outfit(p,w,lod)+'</g>'+mark.chest;
 const acc=look.accessory(t,p,style,w,lod);
 s+=acc.neck+egg.neck+head;
 if(style.ears)s+='<g data-part="ears">'+v4Ears(skin,lod,w)+'</g>';
 s+='<g data-part="face">'+shape(V4_FACE,skin,INK,w)+v4Features(t,skin,lod,false)+'</g>'+egg.face;
 let front=lod<2?shape(style.locks,hc,INK,w*.8):'';
 front+=hairShape(style.fringe);
 if(lod<2&&!beanie)front+=line(style.strands,strand,lod===0?2.6:3);
 if(!beanie)front+=line(style.shine,shine,lod===0?5:lod===1?6:7,' opacity=".75"');
 s+='<g data-part="hair-front">'+front+'</g>';
 s+=acc.front+mark.lens+egg.head+'</g>';
 return s+egg.over+'</g></svg>';
}

// v5 garment colours: soft, friendly tones that sit with the v4 backgrounds, never neon.
const V5_CLOTH=[
 {name:'苔绿',hex:'#3F6B4E'},
 {name:'赤陶',hex:'#B5603F'},
 {name:'莓紫',hex:'#6E4F68'},
 {name:'海蓝',hex:'#3E6E80'},
 {name:'麦黄',hex:'#B88D3E'},
 {name:'雾灰',hex:'#55666A'},
 {name:'奶白',hex:'#EDE6D8'},
 {name:'墨蓝',hex:'#2F3E57'},
 {name:'樱粉',hex:'#D8958C'},
 {name:'薄荷',hex:'#86B19C'},
 {name:'杏橙',hex:'#D98E4F'},
 {name:'丁香',hex:'#9D8DBA'},
 {name:'砖红',hex:'#993F37'},
 {name:'燕麦',hex:'#C8B596'},
];
// Curated [main, accent] pairs: a neutral with one pop colour, analogous neighbours, or soft
// complements. Random characters draw from these; the studio can still pick any two.
const V5_COMBOS=[
 [0,10],[0,6],[0,4],[1,3],[1,6],[1,13],[2,4],[2,8],[2,6],[3,10],[3,6],[3,9],
 [4,7],[4,0],[5,10],[5,8],[5,9],[6,7],[6,12],[6,0],[7,4],[7,8],[7,6],[8,7],
 [8,6],[9,7],[9,6],[10,7],[11,4],[11,6],[12,13],[12,6],[13,0],[13,12],
];

// v5 garment details: the v4 cuts, with the accent colour on collars, trims, linings and pockets.
const crew5='M106 189C114 206 142 206 150 189';
const rib5='M104 188C112 210 144 210 152 188L146 186C140 200 116 200 110 186Z';
const dot5=(x,y,r,fill)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
const V5_OUTFITS=[
 // Sweatshirt: accent rib collar and two chest stripes.
 {name:'圆领卫衣',draw:(p,w,lod)=>shape(rib5,p.accent,INK,w*.75)+(lod<2?line('M40 236C88 228 168 228 216 236',p.accent,6)+line('M86 196C80 210 76 226 74 230M170 196C176 210 180 226 182 230',mix(p.shirt,'#000000',.28),2.6):'')},
 // Shirt: accent collar points and buttons on the main colour.
 {name:'翻领衬衫',draw:(p,w,lod)=>{const c=mix(p.accent,'#FFFFFF',.2);return shape('M110 187L128 210L146 187Z',mix(p.shirt,'#000000',.25),'none')+line('M128 210V262',INK,w*.6)+shape('M108 184L128 210L106 214L96 196Z',c,INK,w*.75)+shape('M148 184L128 210L150 214L160 196Z',c,INK,w*.75)+(lod<2?dot5(132,226,2.6,c)+dot5(132,244,2.6,c):'')}},
 // Cardigan over an accent tee.
 {name:'开衫',draw:(p,w,lod)=>shape('M108 188L148 188L140 262L116 262Z',p.accent,INK,w*.75)+line(crew5,INK,w*.6)+line('M108 188C112 214 116 238 116 262M148 188C144 214 140 238 140 262',INK,w*.75)+(lod<2?dot5(145,222,2.6,INK)+dot5(143,242,2.6,INK):'')},
 // Blazer: light accent tee and an accent pocket square.
 {name:'西装外套',draw:(p,w,lod)=>{const tee=mix(p.accent,'#FFFFFF',.55),lap=mix(p.shirt,'#000000',.18);return shape('M108 188L148 188L136 262L120 262Z',tee,INK,w*.75)+line(crew5,INK,w*.6)+shape('M108 186L98 202L108 208L104 216L124 262L110 262L92 222L90 198Z',lap,INK,w*.75)+shape('M148 186L158 202L148 208L152 216L132 262L146 262L164 222L166 198Z',lap,INK,w*.75)+(lod<2?shape('M170 226L186 226L182 218Z',p.accent,INK,2.4):'')}},
 // Hoodie: accent hood lining and light drawstrings.
 {name:'连帽衫',draw:(p,w,lod)=>{const hood=mix(p.shirt,'#000000',.16),tip=mix(p.accent,'#FFFFFF',.35);return shape('M92 196C84 186 96 176 110 180L128 206L146 180C160 176 172 186 164 196C156 214 140 222 128 222C116 222 100 214 92 196Z',hood,INK,w*.75)+shape('M110 184L128 206L146 184C140 196 116 196 110 184Z',p.accent,'none')+(lod<2?line('M118 214V236M138 214V236',tip,3)+dot5(118,238,2.6,tip)+dot5(138,238,2.6,tip):'')}},
 // Turtleneck: the rolled collar in the accent colour.
 {name:'高领毛衣',draw:(p,w,lod)=>shape('M106 168C106 162 150 162 150 168L152 196C140 206 116 206 104 196Z',p.accent,INK,w*.75)+(lod<2?line('M114 172V198M122 172V202M130 172V202M138 172V202M146 172V198',mix(p.accent,'#000000',.25),2):'')},
 // T-shirt: accent rib collar and pocket.
 {name:'T 恤',draw:(p,w,lod)=>shape(rib5,p.accent,INK,w*.75)+(lod<2?shape('M160 220H184V236C178 242 166 242 160 236Z',p.accent,INK,2.6):'')},
];

// v5 sunglasses: four classic, generic frames worn like the v4 glasses (front layer, head frame,
// lenses centred on the eyes at x 106 / 150, y 130). Each lens is drawn once in local coordinates
// for the viewer's left lens (outer side toward -x) and mirrored for the right one.
const V5_SUNGLASSES=['方框墨镜','飞行员墨镜','眉框墨镜','圆框墨镜'];
const TINT='#2B3440';
const shadeGlint=lod=>lod<2?line('M5 -2L9 -6','#FFFFFF',2.2,' opacity=".7"'):'';
const pair=body=>`<g transform="translate(106 130)">${body}</g><g transform="translate(150 130) scale(-1 1)">${body}</g>`;
// Lens outlines in local coordinates; also used to clip the lens mark.
const V5_LENSES=[
 // Trapezoid: slightly upswept outer corner, narrowing toward the bottom.
 'M-18 -14C-12 -13 8 -12 16 -11L14 9C13 12 10 13 7 13L-8 13C-12 13 -14 11 -15 8Z',
 // Aviator teardrop: wide at the top, drooping toward the nose.
 'M-16 -10C-12 -14 10 -14 15 -10C18 -6 16 6 9 12C4 16 -6 15 -11 9C-16 3 -18 -6 -16 -10Z',
 // Browline: a rounded lens under the brow bar.
 'M-16 -9L16 -9C17 0 15 9 8 12C2 14 -6 14 -11 11C-16 7 -17 -2 -16 -9Z',
 // Round.
 'M-15 0A15 15 0 1 0 15 0A15 15 0 1 0 -15 0Z',
];
const STYLES=[
 // Thick acetate: dark tint, heavy top bar with the outer end flicked up.
 lod=>pair(`<path d="${V5_LENSES[0]}" fill="${TINT}" fill-opacity=".92" stroke="${INK}" stroke-width="3.6" stroke-linejoin="round"/>`+line('M-20 -16C-12 -13 4 -12 18 -11',INK,6.4)+shadeGlint(lod))+
  line('M123 121C126 118 130 118 133 121M88 121L70 118M168 121L186 118',INK,3.4),
 // Thin metal rim, brown gradient tint, double bridge.
 lod=>'<defs><linearGradient id="fuli-avatar-aviator-tint" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3A2A20" stop-opacity=".95"/><stop offset="1" stop-color="#8A6A50" stop-opacity=".8"/></linearGradient></defs>'+
  pair(`<path d="${V5_LENSES[1]}" fill="url(#fuli-avatar-aviator-tint)" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/>`+shadeGlint(lod))+
  line('M121 119H135M122 127C126 124 130 124 134 127M90 122L70 119M166 122L186 119',INK,2.2),
 // Thick dark brow bar, thin metal rim round the lower half, dark green tint.
 lod=>pair(`<path d="${V5_LENSES[2]}" fill="#2E4A40" fill-opacity=".9"/>`+line('M-16 -7C-17 0 -15 8 -9 12C-3 14 4 14 9 12C15 8 17 0 16 -7','#8F99A1',1.8)+
  `<path d="M-18 -13C-10 -15 10 -15 18 -12L17 -6C10 -9 -10 -9 -17 -6Z" fill="${INK}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>`+shadeGlint(lod))+
  line('M124 120C127 118 129 118 132 120M88 120L70 117M168 120L186 117',INK,3),
 // Thin round frames.
 lod=>pair(`<path d="${V5_LENSES[3]}" fill="${TINT}" fill-opacity=".92" stroke="${INK}" stroke-width="3.6"/>`+shadeGlint(lod))+
  line('M121 128C125 124 131 124 135 128M91 126L70 122M165 126L186 122',INK,3.4),
];
function v5Sunglasses(index,lod){return `<g data-part="sunglasses" data-style="${index}">`+STYLES[index](lod)+'</g>';}

// The rare mask is Jevons' own cat drawing (his avatar): the whole cat, head and body, cut from the
// original at 120 x 106 px with a transparent background and embedded as a PNG data URL.
// Generated from the cut-out; do not edit by hand.
const RARE_CAT_PNG='data:image/png;base64,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';

// v5 masks: pushed up onto the upper left of the head, resting on the hair at the side. The long
// axis runs from upper right (forehead) down to lower left (chin) at about 38 degrees, and the
// face is turned toward the upper left in a 3/4 view: the oval is squeezed across its width, the
// features shift toward the far side, and the far eye is smaller and narrower than the near one.
// It never reaches the eyes (lowest point head-frame x < 72) and stays inside the canvas (y >= 27).
const MASK_OVAL='M0 -30C17 -30 24 -14 23 2C22 20 12 30 0 30C-12 30 -22 20 -23 2C-24 -14 -17 -30 0 -30Z';
const maskPath=(d,fill,w)=>`<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const holes=pts=>pts.map(([x,y])=>`<circle cx="${x}" cy="${y}" r="1.6" fill="${INK}"/>`).join('');
const EAR_L='M-21 -12L-17 -36L-4 -26Z',EAR_R='M21 -12L17 -36L4 -26Z';
const INNER_EARS='<path d="M-16 -20L-15.5 -30L-8.5 -25.5ZM16 -20L15.5 -30L8.5 -25.5Z" fill="#E8A0A8"/>';
const catEye=fill=>`<ellipse cx="0" cy="0" rx="5" ry="3.2" transform="rotate(-8)" fill="${fill}"/><ellipse cx="0" cy="0" rx="2" ry="2.6" fill="${INK}"/>`;
const catMid=lod=>'<path d="M-2.8 5H2.8L0 8.6Z" fill="#E58C9A"/>'+line('M-5 11C-3 14 -1 14 0 11C1 14 3 14 5 11',INK,1.8)+
 (lod<2?line('M-11 8L-22 5M-11 11.5L-22 12.5M11 8L22 5M11 11.5L22 12.5',INK,1.6):'');
// Each mask has a base (outline, ears, patches; not shifted), one eye drawn for the near (right)
// side at the origin and mirrored for the far side, and mid features on the centre line.
const V5_MASKS=[
 {name:'冰球面具',en:'Hockey mask',
  base:w=>maskPath(MASK_OVAL,'#F1ECE1',w),
  eye:()=>`<path d="M-6 3C-4 -4 3 -6 6 -1C5 4 -2 6 -6 3Z" fill="${INK}"/>`,
  mid:lod=>lod<2?holes([[-8,-21],[0,-23],[8,-21],[-4,-15],[4,-15],[-16,7],[-11,11],[11,11],[16,7],[-6,19],[0,21],[6,19]])+line('M0 -2V9M-4 12L-2.5 15.5M4 12L2.5 15.5',mix('#F1ECE1','#000000',.35),1.8):''},
 {name:'小丑面具',en:'Clown mask',
  base:w=>maskPath(MASK_OVAL,'#FBF8F2',w),
  eye:()=>`<path d="M0 -11L4.5 0L0 11L-4.5 0Z" fill="#6E9BD6"/><ellipse cx="0" cy="0" rx="2.4" ry="3.2" fill="${INK}"/>`,
  mid:lod=>maskPath('M-15 9C-9 22 9 22 15 9C9 15 -9 15 -15 9Z','#D9534F',2)+`<circle cx="0" cy="3" r="5.4" fill="#D9534F" stroke="${INK}" stroke-width="2.4"/>`+(lod<2?'<circle cx="-1.6" cy="1.4" r="1.5" fill="#FFFFFF"/>':'')},
 {name:'英雄面具',en:'Silver hero mask',
  base:w=>maskPath(MASK_OVAL,'#C7CCD2',w),
  eye:lod=>`<ellipse cx="0" cy="0" rx="8.2" ry="5.4" transform="rotate(-22)" fill="#FFE7A1" stroke="${INK}" stroke-width="2.4"/>`+(lod<2?'<ellipse cx="0" cy="0" rx="3.4" ry="1.8" transform="rotate(-22)" fill="#FFFBEA"/>'+line('M-5 -17C-1 -17 4 -15 8 -9',mix('#C7CCD2','#000000',.3),1.8):''),
  mid:lod=>maskPath('M-2.6 -30L2.6 -30L2 -8L-2 -8Z','#E7EAEE',2)+(lod<2?line('M-7 16H7',INK,2.4):'')},
 // Silver shaded cat: a soft radial shade from silvery white to grey at the edges and ear tips.
 // The gradient ids are shared by every silver cat on a page; all copies are identical.
 {name:'银渐层猫面具',en:'Silver cat mask',
  base:w=>'<defs><radialGradient id="fuli-avatar-silver-cat" cx="0.5" cy="0.55" r="0.62"><stop offset="0.45" stop-color="#F4F5F6"/><stop offset="1" stop-color="#9EA4AB"/></radialGradient>'+
   '<linearGradient id="fuli-avatar-silver-ear" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#E9EBED"/><stop offset="1" stop-color="#7E858D"/></linearGradient></defs>'+
   maskPath(EAR_L,'url(#fuli-avatar-silver-ear)',w)+maskPath(EAR_R,'url(#fuli-avatar-silver-ear)',w)+INNER_EARS+maskPath(MASK_OVAL,'url(#fuli-avatar-silver-cat)',w),
  eye:()=>catEye('#4FA392'),mid:catMid},
 // Bi-colour cat: white with a bold orange patch over the far ear and around the far eye.
 {name:'两花猫面具',en:'Bi-colour cat mask',
  base:w=>{const patch='#D98A3D';return maskPath(EAR_L,patch,w)+maskPath(EAR_R,'#FBF8F2',w)+'<path d="M16 -20L15.5 -30L8.5 -25.5Z" fill="#E8A0A8"/>'+
   `<path d="${MASK_OVAL}" fill="#FBF8F2"/>`+`<path d="M-23 2C-24 -14 -17 -30 0 -30C1 -24 -1 -17 -3 -12C-2 -5 -4 1 -9 4C-14 6 -20 6 -23 2Z" fill="${patch}"/>`+
   `<path d="${MASK_OVAL}" fill="none" stroke="${INK}" stroke-width="${w}" stroke-linejoin="round"/>`;},
  eye:()=>catEye('#E2B23A'),mid:catMid},
];
// The rare mask is Jevons' own cat drawing grown into a plain white oval: no outline, the picture's
// edges fade through a soft radial alpha mask so its white fur flows into the white base, and a
// very soft drop shadow lifts the oval off the hair. No eye holes, so the drawing stays whole.
// The ids are shared by every copy on a page; all copies are identical.
const CAT_DEFS='<defs><clipPath id="fuli-avatar-cat-oval"><path d="'+MASK_OVAL+'"/></clipPath>'+
 '<radialGradient id="fuli-avatar-cat-fade" cx="0.5" cy="0.45" r="0.55"><stop offset="0.62" stop-color="#FFFFFF"/><stop offset="1" stop-color="#000000"/></radialGradient>'+
 '<mask id="fuli-avatar-cat-mask" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#fuli-avatar-cat-fade)"/></mask>'+
 '<filter id="fuli-avatar-cat-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0.6" dy="1.2" stdDeviation="1.6" flood-color="#22303D" flood-opacity=".22"/></filter></defs>';
const V5_RARE_MASK={name:'愁眉猫面具',en:'Worried cat mask',
 picture:()=>CAT_DEFS+`<path d="${MASK_OVAL}" fill="#FFFFFF" filter="url(#fuli-avatar-cat-shadow)"/>`+
  `<g clip-path="url(#fuli-avatar-cat-oval)"><image href="${RARE_CAT_PNG}" x="-25" y="-22" width="50" height="44.17" preserveAspectRatio="none" transform="rotate(-15)" mask="url(#fuli-avatar-cat-mask)"/></g>`};
// 3/4 view: width squeezed, features shifted toward the far (left, -x) side, far eye mirrored and
// smaller. Drawn in the head frame over the fringe; outline width is divided by the 1.2 scale.
const TURN='scale(.78 1)',SHIFT=-3.5;
function v5MaskMarkup(index,w,lod){
 const m=index<V5_MASKS.length?V5_MASKS[index]:V5_RARE_MASK,ey=-5,mw=Math.round(w/1.2*100)/100;
 const place='<g data-part="mask" data-style="'+index+'"><g transform="translate(70 76) rotate(38) scale(1.2)">';
 // A picture cannot move its own features; the oval takes the same squeeze as the other masks.
 if(m.picture)return place+`<g transform="${TURN}">${m.picture()}</g></g></g>`;
 const far=`<g transform="translate(${-9.5+SHIFT} ${ey}) scale(-.7 .86)">${m.eye(lod)}</g>`,near=`<g transform="translate(${9.5+SHIFT/2} ${ey}) scale(1.04 1)">${m.eye(lod)}</g>`;
 return place+`<g transform="${TURN}">`+
  m.base(mw,lod)+far+near+`<g transform="translate(${SHIFT} 0)">${m.mid(lod)}</g></g></g></g>`;
}

// The official FULI wordmark (dist/brand/fuli-wordmark-en.svg): four paths, F U L I, in a 750 x 200
// box (the brand file adds 16 px padding). Copied verbatim from the brand file; do not edit by hand.
const FULI_WORDMARK=Object.freeze([
 'M 5 0 L 193 0 A 5 5 0 0 1 198 5 L 198 37 A 5 5 0 0 1 193 42 L 51.5 42 A 3.5 3.5 0 0 0 48 45.5 L 48 79.5 A 3.5 3.5 0 0 0 51.5 83 L 165 83 A 5 5 0 0 1 170 88 L 170 118 A 5 5 0 0 1 165 123 L 51.5 123 A 3.5 3.5 0 0 0 48 126.5 L 48 195 A 5 5 0 0 1 43 200 L 5 200 A 5 5 0 0 1 0 195 L 0 5 A 5 5 0 0 1 5 0 Z',
 'M 231 0 L 269 0 A 5 5 0 0 1 274 5 L 274 110 C 274 145.5, 297 160.0, 338 160.0 C 379 160.0, 402 145.5, 402 110 L 402 5 A 5 5 0 0 1 407 0 L 445 0 A 5 5 0 0 1 450 5 L 450 113 C 450 173.5, 404 203.5, 338 203.5 C 272 203.5, 226 173.5, 226 113 L 226 5 A 5 5 0 0 1 231 0 Z',
 'M 493 0 L 531 0 A 5 5 0 0 1 536 5 L 536 153.5 A 3.5 3.5 0 0 0 539.5 157 L 669 157 A 5 5 0 0 1 674 162 L 674 195 A 5 5 0 0 1 669 200 L 493 200 A 5 5 0 0 1 488 195 L 488 5 A 5 5 0 0 1 493 0 Z',
 'M 707 0 L 745 0 A 5 5 0 0 1 750 5 L 750 195 A 5 5 0 0 1 745 200 L 707 200 A 5 5 0 0 1 702 195 L 702 5 A 5 5 0 0 1 707 0 Z'
]);

// v5 site signature: a tiny, low-contrast line of text worked into the design like a maker's mark.
// It reads as texture at normal size and only becomes legible when zoomed. Placement comes from its
// own seed namespace, so it never shifts trait draws; about a third of seeds carry none. It only
// sits on a part the character has, in that part's own colour, and never on the face.
const SIG='有点.意思.com';
// Garments with a plain chest: sweatshirt, hoodie, turtleneck, T-shirt.
const PLAIN_CHEST=[0,4,5,6],MARK_HOODIE=4,MARK_BEANIE=4;
const V5_MARK_NONE=1/3;
// The spots that fit these traits, all on clothing or the background. frame: up the background
// edge; chest: under the pocket; label: a sewn tab on the right sleeve; seam: along the left
// shoulder's outline; cord: printed down a hoodie drawstring; hat: a woven tag on the beanie cuff.
function v5MarkSpots(t){
 const spots=['frame','label','seam'];
 if(PLAIN_CHEST.includes(t.outfit))spots.push('chest');
 if(t.outfit===MARK_HOODIE)spots.push('cord');
 if(t.accessory===MARK_BEANIE)spots.push('hat');
 return spots;
}
function v5MarkPlace(seed,t){
 const random=seededRng('mark:',String(seed)),skip=random(),pick=random();
 if(skip<V5_MARK_NONE)return null;
 const spots=v5MarkSpots(t);
 return spots[Math.floor(pick*spots.length)];
}
const lum=hex=>{const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));return .299*r+.587*g+.114*b;};
// A shade a little darker (or lighter, on dark cloth) than what it sits on.
const tone=(hex,k)=>lum(hex)>110?mix(hex,'#000000',k):mix(hex,'#FFFFFF',k);
const sig=(attrs,fill,size)=>`<text ${attrs} font-family="sans-serif" font-size="${size}" text-anchor="middle" dominant-baseline="central" fill="${fill}">${SIG}</text>`;
// The left shoulder of the garment outline (the first curve of V4_BODY), from the collar to the arm.
const SEAM='M110 188C84 190 56 198 42 216';
// A separate lens etching: about one sunglasses wearer in seven gets the FULI wordmark etched in the viewer's
// left lens, near its top outer corner, slanted with the top rim and clipped to the lens so it never
// touches the frame. Its own seed namespace keeps it independent of the site mark above.
const V5_ETCH_RATE=0.15;
const v5LensEtch=(seed,t)=>t.accessory>=7&&t.accessory<=10&&seededRng('etch:',String(seed))()<V5_ETCH_RATE;
const ETCH_SCALE=.0108,ETCH_PATHS=FULI_WORDMARK.map(d=>`<path d="${d}"/>`).join('');
// Keyed by accessory 7-10: [lens outline, x, y, slant].
const LENS_MARKS={
 7:[V5_LENSES[0],-14,-8,4],8:[V5_LENSES[1],-12.5,-8,-8],9:[V5_LENSES[2],-13,-4.4,-4],10:[V5_LENSES[3],-11.5,-7,-16],
};
// Markup per slot: frame (canvas, behind the hair), chest (canvas, on the garment), lens (head frame,
// over the sunglasses) and hat (head frame, inside the beanie group so it follows the hat's tilt).
function v5MarkMarkup(place,p,accessory,etch,lod){
 const out={frame:'',chest:'',lens:'',hat:''};
 if(lod===2)return out;
 // Etched into the tint: the wordmark in white at low opacity.
 if(etch){const [d,x,y,slant]=LENS_MARKS[accessory],id='fuli-avatar-lens-'+accessory;
  out.lens=`<g transform="translate(106 130)"><defs><clipPath id="${id}"><path d="${d}"/></clipPath></defs><g clip-path="url(#${id})">`+
   // The official wordmark paths (750 x 200), scaled to about 8 x 2 lens units, slanted with the rim
   // and centred on the line so it starts at (x, y); inlined so every export keeps it.
   `<g transform="translate(${x} ${y}) rotate(${slant}) scale(${ETCH_SCALE}) translate(0 -100)" fill="#FFFFFF" opacity=".42">${ETCH_PATHS}</g></g></g>`;}
 if(!place)return out;
 if(place==='frame')out.frame=sig('transform="translate(251.6 128) rotate(90)"',tone(p.bg,.16),3.2);
 if(place==='chest')out.chest=sig('x="164" y="250"',tone(p.shirt,.2),3.4);
 if(place==='label'){const tab=tone(p.shirt,.14);
  out.chest=`<g transform="translate(206 242) rotate(-22)"><rect x="-10" y="-3.6" width="20" height="7.2" rx="1.2" fill="${tab}" stroke="${tone(p.shirt,.3)}" stroke-width=".6"/>`+sig('x="0" y="0"',tone(tab,.22),2.1)+'</g>';}
 if(place==='seam')out.chest=`<defs><path id="fuli-avatar-seam" d="${SEAM}"/></defs><text font-family="sans-serif" font-size="2.6" dominant-baseline="central" fill="${mix(INK,'#FFFFFF',.16)}"><textPath href="#fuli-avatar-seam" startOffset="30%">${SIG}</textPath></text>`;
 if(place==='cord')out.chest=sig('transform="translate(138 225) rotate(90)"',tone(mix(p.accent,'#FFFFFF',.35),.28),1.9);
 if(place==='hat'){const cuff=mix(p.accent,'#000000',.2),tag=tone(cuff,.16);
  out.hat=`<g transform="translate(172 92) rotate(4)"><rect x="-10" y="-3.8" width="20" height="7.6" rx="1" fill="${tag}" stroke="${tone(cuff,.32)}" stroke-width=".6"/>`+sig('x="0" y="0"',tone(tag,.24),2.1)+'</g>';}
 return out;
}

// v5 renderer: v4's character with two-colour outfits, sunglasses, rare masks and tilted beanies.
// Traits draw from the '5:' namespace; layer assembly is shared with v4 (composeAvatar).
// Accessory indexes: 0-6 as v4, then sunglasses, then the masks, then the rare mask.
const SHADES_FIRST=V4_ACCESSORIES.length,MASK_FIRST=SHADES_FIRST+V5_SUNGLASSES.length,RARE_MASK=MASK_FIRST+V5_MASKS.length,BEANIE=4;
const V5_ACCESSORIES=[...V4_ACCESSORIES,...V5_SUNGLASSES,...V5_MASKS.map(m=>m.name),V5_RARE_MASK.name];
const V5_HAT_POSES=['正戴','向左歪戴','向右歪戴'];
// One seed in fifty wears a mask. Of those, one in five hundred gets the rare mask; the rest pick
// one of the regular masks, equally likely. A third of beanies tilt.
const V5_MASK_RATE=0.02;
const V5_RARE_MASK_SHARE=0.002;
const TILT_RATE=1/3;
const V5_OPTIONS=Object.freeze({palette:V4_PALETTES.length,skin:V4_SKINS.length,hairColor:V4_HAIR.length,hair:V4_HAIRSTYLES.length,eyes:V4_EYES.length,brows:V4_BROWS.length,mouth:V4_MOUTHS.length,outfit:V5_OUTFITS.length,outfitColor:V5_CLOTH.length,outfitAccent:V5_CLOTH.length,accessory:V5_ACCESSORIES.length,hatPose:V5_HAT_POSES.length});
// Distinct looks: the hat pose only changes a beanie, so it multiplies that one accessory.
const V5_COMBINATIONS=Object.entries(V5_OPTIONS).filter(([k])=>k!=='accessory'&&k!=='hatPose').reduce((a,[,n])=>a*n,1)*(V5_OPTIONS.accessory-1+V5_OPTIONS.hatPose);
const isMask=t=>t.accessory>=MASK_FIRST;
function getTraitsV5(seed='fuli',overrides={}){
 const random=seededRng('5:',String(seed)),o=overrides&&typeof overrides==='object'?overrides:{},t={};
 // Every draw is taken whether or not it is overridden, so overrides never reshuffle other traits.
 const pick=(key,sample)=>{const v=o[key];return Number.isInteger(v)&&v>=0&&v<V5_OPTIONS[key]?v:sample;};
 for(const key of ['palette','skin','hairColor','hair','eyes','brows','mouth','outfit'])t[key]=pick(key,Math.floor(random()*V5_OPTIONS[key]));
 const [main,accent]=V5_COMBOS[Math.floor(random()*V5_COMBOS.length)];
 t.outfitColor=pick('outfitColor',main);t.outfitAccent=pick('outfitAccent',accent);
 const m=random(),a=random(),rare=random();
 const mask=rare<V5_RARE_MASK_SHARE?RARE_MASK:MASK_FIRST+Math.floor(m/V5_MASK_RATE*V5_MASKS.length);
 // Everyday: the seven v4 accessories and sunglasses share nine equal slots; sunglasses keep their
 // two slots, split evenly across the four styles.
 const slot=a*(SHADES_FIRST+2),daily=slot<SHADES_FIRST?Math.floor(slot):SHADES_FIRST+Math.floor((slot-SHADES_FIRST)/2*V5_SUNGLASSES.length);
 t.accessory=pick('accessory',m<V5_MASK_RATE?mask:daily);
 const tilt=random(),side=random();
 t.hatPose=pick('hatPose',tilt<TILT_RATE?(side<.5?1:2):0);
 return t;
}
const v5Palette=t=>({bg:V4_PALETTES[t.palette].bg,shirt:V5_CLOTH[t.outfitColor].hex,accent:V5_CLOTH[t.outfitAccent].hex});
// A tilted beanie rotates about the crown and slides toward the low side; the cuff then reaches
// the brow line on that side and lifts off the hair on the other, never down to the eyes.
const TILTS=[null,{deg:-12,dx:-4},{deg:12,dx:4}];
function v5Accessory(t,p,style,w,lod){
 if(t.accessory>=MASK_FIRST)return {neck:'',front:v5MaskMarkup(t.accessory-MASK_FIRST,w,lod)};
 if(t.accessory>=SHADES_FIRST)return {neck:'',front:v5Sunglasses(t.accessory-SHADES_FIRST,lod)};
 const out=v4Accessory(t,p,style,w,lod),tilt=t.accessory===BEANIE&&TILTS[t.hatPose];
 if(tilt)out.front=out.front.replace('<g data-part="beanie">',`<g data-part="beanie" data-pose="${t.hatPose}" transform="translate(${tilt.dx} -2) rotate(${tilt.deg} 128 100)">`);
 return out;
}
// A mask rests on the upper side of the head, where the top hat and music headphones would go.
const eggClash=t=>egg=>isMask(t)&&(egg.id==='tophat'||egg.id==='hiphop'||egg.id==='pop');
function getEggV5(seed='fuli',overrides={}){const t=getTraitsV5(seed,overrides);return v4ResolveEgg(seed,t,V4_HAIRSTYLES[t.hair],undefined,eggClash(t));}
function createAvatarV5(seed='fuli',config={}){
 const c=config&&typeof config==='object'?config:{},t=getTraitsV5(seed,c.traits);
 const p=v5Palette(t),place=v5MarkPlace(seed,t),etch=v5LensEtch(seed,t),mark=lod=>v5MarkMarkup(place,p,t.accessory,etch,lod);
 // A hat tag goes inside the beanie group, so it follows the hat's tilt.
 const accessory=(t,p,style,w,lod)=>{const out=v5Accessory(t,p,style,w,lod),hat=mark(lod).hat;if(hat)out.front=out.front.replace(/<\/g>$/,hat+'</g>');return out;};
 return composeAvatar(seed,c,t,{id:'v5',palette:p,outfit:V5_OUTFITS[t.outfit].draw,accessory,eggClash:eggClash(t),mark});
}

// Friendly character names, deterministic from the seed. Curated given and family names are
// combined at random; lists avoid famous given+family pairings, and Chinese pairs never repeat
// a character. A name is a display nicety, not an identity: different seeds can share one.
const NAME_LISTS={
 es:{given:['Lucía','Mateo','Valentina','Joaquín','Inés','Tomás','Carmen','Alba','Bruno','Elena','Hugo','Martina','Pablo','Sofía','Nico','Julián','Marisol','Rocío','Emilio','Ximena'],
  family:['Navarro','Bermejo','Ortega','Romero','Vega','Delgado','Campos','Serrano','Robles','Prieto','Paredes','Solís','Aguilar','Castillo','Ibarra','Marín','Quintana','Arroyo']},
 zh:{given:['知夏','予安','青禾','南乔','清和','若溪','听澜','一苇','观月','时雨','小满','晚舟','明川','安歌','书白','念初','嘉木','云舒','知远','星遥'],
  family:['林','周','陈','许','沈','江','苏','程','叶','顾','宋','白','秦','夏','温','陆']},
 en:{given:['Milo','Iris','Theo','Hazel','Felix','June','Arlo','Wren','Oscar','Mabel','Jasper','Ivy','Rowan','Clara','Ezra','Poppy','Otis','Nell','Ada','Silas'],
  family:['Reed','Hart','Finch','Brooks','Lane','Wells','Hale','Quinn','Sutton','Marsh','Ashby','Fairley','Penrose','Holloway','Pike','Calloway']},
};
const NAME_LOCALES=Object.freeze(Object.keys(NAME_LISTS));
const pickFrom=(list,random)=>list[Math.floor(random()*list.length)];
// { name, locale, given, family }. `locales` narrows the mix; unknown entries are ignored.
function characterName(seed='fuli',config={}){
 const asked=config&&Array.isArray(config.locales)?NAME_LOCALES.filter(l=>config.locales.includes(l)):[];
 const locales=asked.length?asked:NAME_LOCALES,random=seededRng('name:',String(seed));
 const locale=locales[Math.floor(random()*locales.length)],lists=NAME_LISTS[locale];
 const given=pickFrom(lists.given,random);
 let family=pickFrom(lists.family,random);
 // A family character repeated in the given name (白书白) reads oddly; step to the next family.
 for(let i=lists.family.indexOf(family);locale==='zh'&&given.includes(family);)family=lists.family[i=(i+1)%lists.family.length];
 return Object.freeze({name:locale==='zh'?family+given:given+' '+family,locale,given,family});
}

// Public API. Render version 5 is the default; { version: 4 } and { version: 3 } redraw stored
// identities byte-identically.
export const VERSION='5';
export const VERSIONS=Object.freeze(['3','4','5']);
// Background tones (v5 uses each palette's bg; v4 also takes its shirt and accent).
export const palettes=V4_PALETTES;
export const hairColors=V4_HAIR;
export const outfitColors=Object.freeze(V5_CLOTH.map(c=>Object.freeze({...c})));
// Curated [main, accent] outfit colour pairs that random characters draw from.
export const outfitCombos=Object.freeze(V5_COMBOS.map(pair=>Object.freeze(pair.slice())));
export const masks=Object.freeze([...V5_MASKS,V5_RARE_MASK].map(({name,en})=>Object.freeze({name,en})));
export const maskRate=V5_MASK_RATE;
export const options=V5_OPTIONS;
export const combinationCount=V5_COMBINATIONS;
const v4Parts=Object.freeze({hairColor:V4_HAIR.map(h=>h.name),hair:V4_HAIRSTYLES.map(h=>h.name),eyes:V4_EYES.map(e=>e.name),brows:V4_BROWS.map(b=>b.name),mouth:V4_MOUTHS.map(m=>m.name),outfit:V4_OUTFITS.map(o=>o.name),accessory:V4_ACCESSORIES.slice()});
// Display names for every selectable v5 part, in trait index order.
export const partNames=Object.freeze({...v4Parts,outfitColor:V5_CLOTH.map(c=>c.name),outfitAccent:V5_CLOTH.map(c=>c.name),accessory:V5_ACCESSORIES.slice(),hatPose:V5_HAT_POSES.slice()});
export const v3=Object.freeze({VERSION:V3_VERSION,palettes:V3_PALETTES,options:V3_OPTIONS,combinationCount:V3_COMBINATIONS,getTraits:getTraitsV3,createAvatar:createAvatarV3});
export const v4=Object.freeze({VERSION:'4',palettes:V4_PALETTES,options:V4_OPTIONS,combinationCount:V4_COMBINATIONS,partNames:v4Parts,getTraits:getTraitsV4,createAvatar:createAvatarV4});
const versionOf=config=>{const v=config&&typeof config==='object'?String(config.version):'';return v==='3'||v==='4'?v:'5';};
const objectOr=o=>o&&typeof o==='object'?o:{};
export function getTraits(seed='fuli',overrides={},config={}){const v=versionOf(config);return v==='3'?getTraitsV3(seed,objectOr(overrides)):v==='4'?getTraitsV4(seed,overrides):getTraitsV5(seed,overrides);}
export function createAvatar(seed='fuli',config={}){const v=versionOf(config);return v==='3'?createAvatarV3(seed,config):v==='4'?createAvatarV4(seed,config):createAvatarV5(seed,config);}
// Opt-in easter eggs (render versions 4 and 5): createAvatar(seed, { eggs: true }) draws one for
// eggRate of seeds (one in eight); { egg: id } forces one; { animate: false } keeps it still.
// getEgg says which egg a seed would show.
export const eggs=Object.freeze(V4_EGGS.map(({id,name,en,loop})=>Object.freeze({id,name,en,loop})));
export const eggRate=V4_EGG_RATE;
export function getEgg(seed='fuli',overrides={},config={}){
 const v=versionOf(config);if(v==='3')return null;
 const e=v==='4'?getEggV4(seed,overrides):getEggV5(seed,overrides);
 return e?eggs.find(x=>x.id===e.id):null;
}
// A still frame `seconds` into an egg's animation (`loop` seconds long), e.g. for GIF export.
export function freezeFrame(svg,seconds){return v4FreezeFrame(svg,seconds);}
// Character names mixed across Spanish, Chinese and English, deterministic from the seed.
export const nameLocales=NAME_LOCALES;
// nameDetails adds { locale, given, family }; config.locales narrows the mix, e.g. ['zh'].
export function nameFor(seed='fuli',config={}){return characterName(seed,config).name;}
export function nameDetails(seed='fuli',config={}){return characterName(seed,config);}
