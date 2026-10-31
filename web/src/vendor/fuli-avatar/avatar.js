/** fuli-avatar v0.4.0. Pure, dependency-free, deterministic SVG generator. */
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
function v4Rng(seed){let h=2166136261;for(const c of `4:${seed}`){h^=c.codePointAt(0);h=Math.imul(h,16777619);}return()=>{h+=0x6D2B79F5;let t=h;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
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
const V4_ACCESSORIES=['无','圆框眼镜','方框眼镜','耳机','毛线帽','围巾','发夹'];
// Layer "front": drawn after the fringe. Layer "neck": drawn over the garment, under the face.
function v4Accessory(t,p,style,w,lod){
 const a=t.accessory,out={neck:'',front:''};
 if(a===1||a===2)out.front=glasses(a===1);
 if(a===3){const top=Math.max(style.top-10,26),band=`M60 122C50 ${top+40} 80 ${top} 128 ${top}C176 ${top} 206 ${top+40} 196 122`;
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

// v4 renderer: assembles layers back to front. Seed is only hashed; no input reaches the markup.
// 1.15x about (128,182): head fills ~55% of the tile width and sits higher.
const HEAD='matrix(1.15 0 0 1.15 -19.2 -27.3)';
const V4_OPTIONS=Object.freeze({palette:V4_PALETTES.length,skin:V4_SKINS.length,hairColor:V4_HAIR.length,hair:V4_HAIRSTYLES.length,eyes:V4_EYES.length,brows:V4_BROWS.length,mouth:V4_MOUTHS.length,outfit:V4_OUTFITS.length,accessory:V4_ACCESSORIES.length});
const V4_COMBINATIONS=Object.values(V4_OPTIONS).reduce((a,b)=>a*b,1);
function getTraitsV4(seed='fuli',overrides={}){const random=v4Rng(String(seed)),o=overrides&&typeof overrides==='object'?overrides:{};return Object.fromEntries(Object.entries(V4_OPTIONS).map(([key,count])=>{const value=o[key],sample=Math.floor(random()*count);return[key,Number.isInteger(value)&&value>=0&&value<count?value:sample];}));}
function createAvatarV4(seed='fuli',config={}){
 const c=config&&typeof config==='object'?config:{};
 const t=getTraitsV4(seed,c.traits);
 const size=Number.isInteger(c.size)&&c.size>=16&&c.size<=4096?c.size:256;
 // Level of detail: 0 full, 1 medium (≤96 px), 2 icon (≤48 px). Fine lines drop out as size shrinks.
 const lod=size<=48?2:size<=96?1:0,w=pen(lod);
 const p=V4_PALETTES[t.palette],skin=V4_SKINS[t.skin],hc=V4_HAIR[t.hairColor].base,style=V4_HAIRSTYLES[t.hair];
 const light=t.hairColor>=4,beanie=t.accessory===4;
 const rounded=c.rounded!==false,rx=rounded?36:0;
 const strand=mix(hc,light?'#5A4630':'#FFFFFF',light?.35:.16),shine=mix(hc,'#FFFFFF',light?.6:.38);
 let s=`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-label="Generated FULI avatar">`;
 s+=`<defs><clipPath id="fuli-avatar-v4-${rounded?'r':'s'}"><rect width="256" height="256" rx="${rx}"/></clipPath></defs>`;
 s+=`<rect width="256" height="256" rx="${rx}" fill="${c.transparent?'none':p.bg}"/>`;
 s+=`<g data-part="portrait" clip-path="url(#fuli-avatar-v4-${rounded?'r':'s'})">`;
 const hairShape=d=>shape(d,hc,INK,w);
 // Head, hair and head-worn pieces share one frame scaled about the chin so the neck joint stays put.
 const head=`<g data-part="head" transform="${HEAD}">`;
 let back='';
 if(!beanie)back+=hairShape(style.tufts);
 if(style.bun&&!beanie)back+=hairShape(style.bun)+(lod<2?line(style.bunShine,shine,3,' opacity=".8"'):'');
 back+=hairShape(style.back);
 s+=head+'<g data-part="hair-back">'+back+'</g></g>';
 s+='<g data-part="neck">'+shape(V4_NECK,skin,INK,w)+shape('M110 180C118 190 138 190 146 180L146 190C138 196 118 196 110 190Z',mix(skin,'#9A5A44',.22),'none')+'</g>';
 s+=`<g data-part="outfit" data-style="${t.outfit}">`+shape(V4_BODY,p.shirt,INK,w)+(lod<2?line(V4_FOLDS,mix(p.shirt,'#000000',.3),2.6):'')+V4_OUTFITS[t.outfit].draw(p,w,lod)+'</g>';
 const acc=v4Accessory(t,p,style,w,lod);
 s+=acc.neck+head;
 if(style.ears)s+='<g data-part="ears">'+v4Ears(skin,lod,w)+'</g>';
 s+='<g data-part="face">'+shape(V4_FACE,skin,INK,w)+v4Features(t,skin,lod,false)+'</g>';
 let front=lod<2?shape(style.locks,hc,INK,w*.8):'';
 front+=hairShape(style.fringe);
 if(lod<2&&!beanie)front+=line(style.strands,strand,lod===0?2.6:3);
 if(!beanie)front+=line(style.shine,shine,lod===0?5:lod===1?6:7,' opacity=".75"');
 s+='<g data-part="hair-front">'+front+'</g>';
 s+=acc.front+'</g>';
 return s+'</g></svg>';
}

// Public API. Render version 4 is the default; pass { version: 3 } to redraw a stored v3 identity.
export const VERSION='4';
export const VERSIONS=Object.freeze(['3','4']);
export const palettes=V4_PALETTES;
export const hairColors=V4_HAIR;
export const options=V4_OPTIONS;
export const combinationCount=V4_COMBINATIONS;
// Display names for every selectable v4 part, in trait index order.
export const partNames=Object.freeze({hairColor:V4_HAIR.map(h=>h.name),hair:V4_HAIRSTYLES.map(h=>h.name),eyes:V4_EYES.map(e=>e.name),brows:V4_BROWS.map(b=>b.name),mouth:V4_MOUTHS.map(m=>m.name),outfit:V4_OUTFITS.map(o=>o.name),accessory:V4_ACCESSORIES.slice()});
export const v3=Object.freeze({VERSION:V3_VERSION,palettes:V3_PALETTES,options:V3_OPTIONS,combinationCount:V3_COMBINATIONS,getTraits:getTraitsV3,createAvatar:createAvatarV3});
const isV3=config=>config&&typeof config==='object'&&(config.version===3||config.version==='3');
export function getTraits(seed='fuli',overrides={},config={}){return isV3(config)?getTraitsV3(seed,overrides&&typeof overrides==='object'?overrides:{}):getTraitsV4(seed,overrides);}
export function createAvatar(seed='fuli',config={}){return isV3(config)?createAvatarV3(seed,config):createAvatarV4(seed,config);}
