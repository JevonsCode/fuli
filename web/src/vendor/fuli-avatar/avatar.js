/** fuli-avatar v0.3.0. Pure, dependency-free, deterministic SVG generator. */
export const VERSION = '3';
export const palettes = [
 {name:'苔原绿',bg:'#E3E9E2',shirt:'#345B3C',accent:'#D77632',hair:'#192D3C'},
 {name:'海盐蓝',bg:'#DEE8EC',shirt:'#3B7685',accent:'#E8B75B',hair:'#263B4B'},
 {name:'莓果紫',bg:'#EAE2E8',shirt:'#75516A',accent:'#D7976C',hair:'#403A49'},
 {name:'暖麦黄',bg:'#F0E9D7',shirt:'#BC8C38',accent:'#47766B',hair:'#594536'},
 {name:'赤陶橙',bg:'#EEDFD6',shirt:'#B86446',accent:'#59786F',hair:'#483B35'},
 {name:'雾松灰',bg:'#D6DFDA',shirt:'#566C69',accent:'#C7A45A',hair:'#F0F0E8'},
];
export const options = Object.freeze({palette:6,skin:5,hair:10,eyes:8,mouth:6,outfit:10,accessory:11,decoration:3});
export const combinationCount=Object.values(options).reduce((a,b)=>a*b,1);
const skins=['#FFE8CF','#F4D2AD','#DDB18B','#BA8768','#8E604C'];
const ink='#1D3040';
function rng(seed){let h=2166136261;for(const c of `${VERSION}:${seed}`){h^=c.codePointAt(0);h=Math.imul(h,16777619);}return()=>{h+=0x6D2B79F5;let t=h;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
export function getTraits(seed='fuli',overrides={}){const random=rng(String(seed));return Object.fromEntries(Object.entries(options).map(([key,count])=>{const value=overrides[key],sample=Math.floor(random()*count);return[key,Number.isInteger(value)&&value>=0&&value<count?value:sample];}));}
export function createAvatar(seed='fuli',config={}){
 const t=getTraits(seed,config.traits);const p=palettes[t.palette],skin=skins[t.skin];const size=Number.isInteger(config.size)&&config.size>=16&&config.size<=4096?config.size:256;
 const path=(d,fill='none',width=5)=>`<path d="${d}" fill="${fill}" stroke="${ink}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
 const circle=(x,y,r,fill,stroke=ink,w=5)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${w}"/>`;
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
  out+=circle(132,217,1.7,cream,ink,1)+circle(132,228,1.7,cream,ink,1);
 }else if(t.outfit===3){ // Breton tee stripes stay within the garment silhouette.
  out+=path('M106 185Q128 209 150 185','none',3.5);
  out+=path('M67 208H189M62 220H194M60 232H196', 'none',4).replace(`stroke="${ink}"`,`stroke="${cream}"`);
 }else if(t.outfit===4){ // Hoodie: two soft hood folds, a V opening, and paired drawstrings.
  out+=path('M108 184L96 188Q98 202 112 207L128 199L144 207Q158 202 160 188L148 184Q128 203 108 184Z',p.shirt,3.5);
  out+=path('M112 207V220M144 207V220','none',2.6);
  out+=circle(112,220,1.8,cream,ink,1)+circle(144,220,1.8,cream,ink,1);
  out+=path('M111 225L105 234H151L145 225','none',2.5);
 }else if(t.outfit===5){ // Oxford shirt, folded collar and center placket.
  out+=path('M108 184L99 191L115 204L127 194L139 204L157 191L148 184Q128 201 108 184Z',cream,3);
  out+=path('M127 196V237','none',2.5);
  out+=circle(133,212,1.6,cream,ink,1)+circle(133,224,1.6,cream,ink,1);
 }else if(t.outfit===6){ // Dungarees over a tee, straps meet the bib rather than the neck.
  out+=path('M106 185Q128 209 150 185','none',3);
  out+=path('M91 188L99 187L104 209H153L158 187L166 190L163 237H94Z',p.accent,3.5);
  out+=circle(104,210,2.5,cream,ink,1.5)+circle(153,210,2.5,cream,ink,1.5);
  out+=path('M116 217H141V227Q129 231 116 227Z','none',2.5);
 }else if(t.outfit===7){ // Soft high-neck knit with a distinct folded collar.
  out+=path('M108 183Q128 193 148 183L151 196Q128 205 105 196Z',p.shirt,3.5);
  out+=path('M113 190V196M123 193V199M133 193V199M143 190V196M72 216V233M184 216V233','none',2);
 }else if(t.outfit===8){ // Rugby polo, contrasting yoke and a compact collar.
  out+=path('M65 207H191M61 216H195','none',5).replace(`stroke="${ink}"`,`stroke="${cream}"`);
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
 if(t.hair===8||t.hair===9)out+=path('M52 79Q47 70 56 65M81 47Q90 39 97 46M121 34Q131 28 137 36M173 49Q184 45 188 56M202 84Q210 89 204 97','none',2.5).replace(`stroke="${ink}"`,'stroke="#ffffff" opacity=".12"');
 // Ear cushions remain at the shared anchors. Only the upper headband expands for fuller hair.
 if(t.accessory===2){const full=t.hair>=8,left=full?27:43,right=full?229:213,top=full?3:19;
  const arch=`M48 127Q${left} 113 ${left} 94Q${left} ${top} 128 ${top}Q${right} ${top} ${right} 94Q${right} 113 208 127`;
  out+='<g data-part="headphone-band">'+path(arch,'none',10)+path(arch,'none',4).replace(`stroke="${ink}"`,`stroke="${p.accent}"`)+'</g>';
 }
 const eyes=[`<ellipse cx="105" cy="129" rx="8" ry="11" fill="${ink}"/><ellipse cx="157" cy="125" rx="8" ry="11" fill="${ink}"/>`,path('M95 130Q103 119 111 130M149 130Q157 119 165 130','none',5),path('M96 129H110','none',5)+`<ellipse cx="157" cy="125" rx="8" ry="11" fill="${ink}"/>`,`<ellipse cx="103" cy="129" rx="6" ry="9" fill="${ink}"/><ellipse cx="157" cy="129" rx="6" ry="9" fill="${ink}"/>`,path('M94 124L103 130L112 124M148 124L157 130L166 124','none',5),circle(103,128,7,ink,ink,1)+circle(157,128,7,ink,ink,1)+circle(105,126,2,'white','none',0)+circle(159,126,2,'white','none',0)];
 eyes.push(path('M95 127Q104 137 113 127M149 124Q157 134 165 124','none',4),path('M97 124L104 128L98 132','none',4)+`<ellipse cx="157" cy="125" rx="7" ry="10" fill="${ink}"/>`);
 // Glasses cover the eye area; avoid eyebrows or pupils poking through star/cat-eye points.
 if(t.accessory<8)out+=path('M96 111Q103 107 111 110M150 107Q157 102 164 106','none',4)+eyes[t.eyes];
 out+=path('M130 137Q126 143 132 144','none',3);
 out+=['M118 153Q132 164 146 150','M119 153Q130 157 142 151','M123 152Q130 164 137 152Z','M122 154H139','M119 151Q132 170 146 149Z','M127 153Q128 146 135 148Q141 153 136 159Q129 162 127 153Z'].map((d,i)=>i===t.mouth?path(d,i===2||i===4||i===5?ink:'none',4):'').join('');
 out+=`<ellipse cx="87" cy="146" rx="9" ry="4" fill="#DC8F79" opacity=".30"/><ellipse cx="174" cy="146" rx="9" ry="4" fill="#DC8F79" opacity=".30"/>`;
 const accessories=['',
 circle(105,129,19,'none',ink,4)+circle(157,125,19,'none',ink,4)+path('M124 127Q131 121 138 125M85 126L69 121M176 121L190 117','none',4),
 `<g><rect x="36" y="111" width="25" height="42" rx="11" fill="${ink}"/><rect x="39" y="114" width="16" height="36" rx="8" fill="${p.accent}"/><path d="M43 120v22" stroke="#FFF5DF" stroke-opacity=".55" stroke-width="2.5" stroke-linecap="round"/><rect x="55" y="118" width="7" height="28" rx="3.5" fill="${ink}"/><rect x="195" y="111" width="25" height="42" rx="11" fill="${ink}"/><rect x="201" y="114" width="16" height="36" rx="8" fill="${p.accent}"/><path d="M212 120v22" stroke="#FFF5DF" stroke-opacity=".55" stroke-width="2.5" stroke-linecap="round"/><rect x="194" y="118" width="7" height="28" rx="3.5" fill="${ink}"/><path d="M209 151Q209 167 178 165" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/><rect x="166" y="161" width="15" height="8" rx="4" fill="${ink}"/></g>`,
 `<g data-part="perched-hat" transform="translate(0 ${-[0,0,3,5,0,4,5,0,14,9][t.hair]}) rotate(-25 80 58)">`+
 path('M53 54V39Q53 18 76 18Q99 18 99 39V54Z','#27323A',3.5)+
 path('M53 46Q76 52 99 46V55Q76 61 53 55Z','#46535A',2)+
 `<ellipse cx="76" cy="57" rx="38" ry="8" fill="#27323A" stroke="${ink}" stroke-width="3.5"/>`+
 path('M58 29Q66 21 77 23','none',2).replace(`stroke="${ink}"`,'stroke="#677178"')+`</g>`,
 `<g transform="rotate(-8 128 73)">`+path('M51 76Q51 31 120 28Q181 25 199 73L198 90L51 94Z',p.accent,5)+path('M50 76Q122 64 199 74L198 94Q121 83 51 96Z',p.accent,5)+path('M69 78V89M86 76V87M104 74V86M122 74V85M140 74V85M158 75V86M177 77V88','none',2)+`<rect x="146" y="76" width="21" height="14" rx="3" fill="#F7E9D2"/>`+path('M152 86L157 80L162 86','none',2)+`</g>`,
 `<g transform="rotate(24 182 99)"><rect x="167" y="93" width="29" height="10" rx="5" fill="${p.accent}" stroke="${ink}" stroke-width="2.5"/><path d="M174 98h14" stroke="#FFF4D8" stroke-width="2" stroke-linecap="round"/></g>`,
 circle(200,146,3,'#F5D381',ink,1.5)+`<ellipse cx="201" cy="156" rx="7" ry="9" fill="none" stroke="${ink}" stroke-width="5"/><ellipse cx="201" cy="156" rx="7" ry="9" fill="none" stroke="#D5A94D" stroke-width="3"/><path d="M197 151Q194 155 197 160" fill="none" stroke="#FCE3A0" stroke-width="1.5" stroke-linecap="round"/>`];
 // Sunglasses belong to the same small-accessories selector as the chain and hats.
 const lens='#20303C',shine='#A4C5C2';
 const arms=path('M84 124L69 119M176 121L192 116M121 126Q130 120 139 124','none',3.5);
 const sunglasses=[
  arms+path('M85 117Q102 112 121 117L119 132Q115 142 101 140Q89 139 87 130Z',lens,3)+path('M139 114Q157 109 175 114L174 128Q171 139 157 137Q143 136 141 128Z',lens,3)+path('M94 121L104 119M149 118L159 116','none',2.5).replace(`stroke="${ink}"`,`stroke="${shine}"`),
  arms+path('M103 109L109 120L122 121L113 130L115 143L103 137L91 143L94 130L84 121L97 120Z',lens,3)+path('M156 106L162 117L175 118L166 127L168 140L156 134L144 140L147 127L137 118L150 117Z',lens,3)+path('M98 123L103 120M151 120L156 117','none',2).replace(`stroke="${ink}"`,`stroke="${shine}"`),
  arms+path('M82 114L121 118Q125 136 108 141Q93 144 88 128Z',lens,3)+path('M137 117L178 109L174 125Q172 138 157 139Q140 139 137 117Z',lens,3)+path('M92 119L102 121M150 121L161 118','none',2.5).replace(`stroke="${ink}"`,`stroke="${shine}"`)
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
