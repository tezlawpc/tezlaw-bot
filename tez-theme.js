// ============================================================
//  tez-theme.js — THE TEZ BRAND, FOR PAGES OUTSIDERS SEE
//  TEZ Law Firm (Tez Law P.C.)
//  ─────────────────────────────────────────────────────────
//  JJ, signed in as a consultant: "keep the design theme similar
//  to tez." The consultant portal had been drawn in navy and gold
//  with emoji for icons — none of which is in the brand guide.
//
//  From TEZ-Brand-Guidelines v1.1:
//    Seal Orange  #FF7B00   the seal, accents. Marks; never floods.
//                           Not for small text on a light ground.
//    Ember        #A34C00   orange TEXT on light (passes contrast)
//    Charcoal     #2B2523   primary dark, body text
//    Travertine   #E8E3DC   panels, rules
//    Marble       #FAF8F5   page
//    Cormorant Garamond — headlines.  Montserrat — body and labels,
//    wide-tracked caps for small labels.  No emoji as icons.
//    The wordmark is never retyped: the shield is drawn from the
//    kit's own vector, and the words beside it are a page title,
//    not a logo.
//
//  One file, so the portal and the firm-side approval page cannot
//  drift apart, and so a palette change is made in one place.
// ============================================================

const C = {
  orange: "#FF7B00", ember: "#A34C00", charcoal: "#2B2523", ink: "#1E1B1A",
  stone: "#5E5854", travertine: "#E8E3DC", marble: "#FAF8F5", white: "#FFFFFF",
  good: "#2F6B3F", bad: "#9C2B1E",
};

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// The shield, full colour for dark grounds, from 02-Logo-Files/SVG in the kit.
const SHIELD = `<svg class="tez-shield" role="img" aria-label="TEZ Law Firm" xmlns="http://www.w3.org/2000/svg" viewBox="134.0 25.0 262.3 289.0"><path fill="#FAF8F5" fill-rule="evenodd" d="M201.33 28.33 L201.17 29.17 L201.33 29.83 L201.33 55.83 L201.83 56.50 L202.33 56.67 L327.83 56.67 L328.67 55.83 L328.67 28.33 L327.83 27.67 L202.33 27.67Z M208.83 38.33 L209.33 36.33 L210.00 35.67 L211.00 35.33 L319.67 35.33 L320.17 35.50 L320.83 36.17 L321.00 36.67 L321.00 47.67 L320.67 48.50 L320.17 48.83 L271.17 48.83 L271.00 49.00 L211.83 48.83 L210.83 49.00 L209.83 48.67 L209.33 48.17 L209.00 47.33Z M392.83 27.17 L392.17 27.00 L383.67 27.00 L383.50 27.17 L370.00 27.17 L369.83 27.33 L361.00 27.33 L360.83 27.50 L353.00 27.50 L352.83 27.67 L342.67 27.67 L341.83 28.33 L341.67 28.83 L341.67 54.83 L341.83 55.00 L341.67 56.83 L341.83 57.50 L342.33 58.17 L342.83 58.33 L351.50 58.17 L351.67 58.00 L359.50 58.00 L360.17 58.67 L361.00 69.00 L362.17 75.33 L362.33 81.33 L363.00 83.50 L364.17 85.17 L365.17 87.17 L366.00 88.17 L367.00 90.17 L368.17 91.67 L369.17 93.83 L370.17 95.17 L371.00 97.00 L371.83 98.00 L373.00 100.33 L373.83 101.33 L375.00 103.67 L375.83 104.67 L377.00 107.00 L380.00 111.50 L381.00 113.67 L381.83 114.67 L383.00 117.17 L384.00 118.50 L384.83 120.83 L384.83 126.83 L385.17 129.17 L385.17 135.83 L385.33 136.00 L385.33 139.00 L385.67 142.17 L385.67 148.50 L385.83 148.67 L386.00 158.50 L386.17 158.67 L386.17 166.17 L386.50 169.33 L386.33 176.83 L386.50 177.00 L386.67 184.50 L386.83 184.67 L386.67 192.50 L386.50 192.67 L386.00 199.67 L385.17 202.33 L384.00 209.33 L383.00 211.67 L383.00 212.33 L381.83 216.67 L381.17 217.83 L380.00 221.83 L379.00 223.67 L378.00 226.83 L377.00 228.50 L376.17 231.00 L375.17 232.50 L373.67 235.83 L373.17 236.33 L372.00 238.83 L371.00 240.17 L370.00 242.17 L366.00 248.17 L362.00 253.33 L356.67 259.17 L351.33 264.50 L345.67 269.67 L337.83 275.83 L335.83 277.00 L334.17 278.33 L332.83 279.00 L331.67 280.00 L330.17 280.67 L325.00 283.83 L320.33 286.17 L318.83 286.67 L316.17 288.17 L314.33 288.83 L312.00 290.17 L310.17 290.83 L307.83 292.17 L305.00 293.00 L303.17 294.00 L299.67 295.00 L298.33 295.83 L293.83 297.17 L291.67 298.17 L288.00 299.00 L285.67 300.00 L280.50 301.00 L278.00 302.00 L276.83 302.00 L276.17 301.33 L276.50 291.17 L276.67 290.67 L277.33 290.00 L278.83 289.67 L280.83 288.67 L284.67 287.67 L285.67 287.00 L289.33 285.83 L291.00 284.83 L293.67 284.00 L295.33 283.00 L297.67 282.17 L306.67 277.67 L307.50 277.00 L310.50 275.67 L315.83 272.33 L317.00 271.83 L321.50 268.67 L323.33 267.67 L331.33 261.83 L341.83 252.50 L349.67 244.00 L354.17 238.17 L356.83 234.00 L357.83 232.83 L360.50 228.33 L360.67 227.67 L361.67 226.33 L363.00 223.33 L363.83 222.17 L364.67 219.83 L365.83 217.83 L366.83 214.67 L367.83 212.83 L369.00 208.50 L369.83 206.83 L370.83 201.50 L371.83 198.67 L372.00 196.50 L372.67 193.17 L372.83 190.17 L373.67 186.67 L373.67 180.83 L374.00 179.17 L374.00 167.33 L374.33 164.83 L374.33 158.67 L374.50 158.50 L374.50 153.33 L374.67 153.17 L374.67 144.00 L375.00 141.33 L375.00 134.00 L375.50 132.50 L375.50 131.50 L375.00 131.00 L374.33 130.83 L368.17 130.67 L367.33 131.33 L367.17 132.17 L366.83 154.50 L366.67 154.67 L366.67 159.67 L366.50 159.83 L366.33 169.33 L366.17 169.50 L366.00 183.83 L365.83 184.00 L365.83 186.33 L365.00 190.83 L364.83 193.83 L364.33 195.83 L364.00 198.67 L363.00 201.17 L362.17 205.33 L361.17 207.50 L360.17 211.00 L359.17 212.67 L358.17 215.67 L357.17 217.33 L355.83 220.83 L352.00 227.50 L349.00 231.50 L347.83 233.50 L342.33 240.50 L337.67 245.50 L332.00 251.00 L323.33 258.17 L311.50 266.00 L309.33 267.00 L308.33 267.83 L305.50 269.17 L304.67 269.83 L291.67 276.33 L289.33 277.17 L287.67 278.17 L284.50 279.17 L283.50 279.83 L278.83 281.17 L277.67 281.83 L272.67 283.17 L270.50 284.67 L269.00 286.67 L268.33 290.33 L268.33 306.50 L268.17 306.67 L268.00 310.67 L268.33 311.67 L268.67 311.83 L271.67 311.67 L273.17 311.00 L278.83 309.83 L281.17 308.83 L287.00 307.67 L288.83 306.83 L293.33 305.83 L295.50 304.83 L299.67 303.83 L301.67 302.83 L305.67 301.67 L307.00 300.83 L310.17 299.83 L311.83 298.83 L314.17 298.00 L326.83 291.67 L327.67 291.00 L330.50 289.67 L336.67 286.00 L342.33 282.17 L343.67 281.00 L345.33 280.00 L353.50 273.00 L355.83 271.33 L362.33 264.67 L368.00 258.17 L370.67 254.50 L371.67 253.50 L377.83 244.33 L379.00 242.00 L379.50 241.50 L380.83 238.50 L381.50 237.67 L382.67 234.83 L384.00 232.50 L384.67 230.50 L386.00 228.00 L386.83 225.17 L387.67 223.83 L388.83 219.50 L389.83 217.17 L391.00 211.50 L391.83 209.50 L392.83 202.83 L393.83 199.00 L394.00 194.67 L394.17 194.50 L394.17 191.67 L394.33 191.50 L394.17 165.00 L394.00 164.83 L394.00 160.83 L393.83 160.67 L393.83 151.33 L393.67 151.17 L393.67 149.00 L393.33 147.67 L393.50 138.00 L392.83 134.67 L393.00 122.67 L392.83 122.50 L392.67 118.83 L391.67 116.17 L391.00 115.33 L389.83 112.83 L389.00 111.83 L387.83 109.33 L387.00 108.33 L385.83 106.00 L382.50 100.83 L381.83 99.33 L381.00 98.33 L378.00 93.00 L376.67 91.17 L375.67 89.00 L374.67 87.67 L373.83 85.83 L373.00 84.83 L372.00 82.67 L370.67 80.67 L370.00 78.17 L369.33 70.67 L368.83 67.83 L367.83 53.83 L367.33 51.00 L367.00 50.33 L366.50 50.00 L350.33 50.17 L349.50 49.33 L349.50 36.67 L350.17 35.83 L350.83 35.50 L353.33 35.00 L361.50 35.00 L364.50 35.33 L372.83 35.33 L373.00 35.17 L380.33 35.00 L380.50 34.83 L384.67 34.83 L385.67 35.67 L385.67 63.67 L385.17 68.33 L385.17 74.17 L385.83 74.83 L392.67 74.83 L393.33 74.17 L393.33 37.83 L393.50 37.67 L393.50 28.50 L393.33 27.67Z M137.33 27.17 L136.83 27.67 L136.83 74.33 L137.83 75.00 L138.17 74.83 L144.00 74.83 L144.83 74.00 L144.67 62.17 L144.50 62.00 L144.50 36.00 L145.17 35.00 L145.50 34.83 L149.83 34.83 L150.00 35.00 L154.17 35.00 L157.33 35.33 L165.00 35.33 L165.17 35.50 L179.17 35.33 L180.17 35.67 L180.83 36.83 L180.83 49.00 L180.17 50.00 L179.83 50.17 L172.67 50.17 L172.50 50.00 L163.83 49.83 L163.00 50.33 L162.67 51.50 L161.83 63.17 L161.17 66.17 L160.67 74.17 L160.00 79.83 L159.00 81.33 L158.17 83.17 L156.83 85.00 L156.17 86.50 L154.67 88.67 L154.00 90.17 L153.17 91.17 L152.17 93.33 L150.67 95.50 L147.83 100.67 L147.00 101.67 L144.00 107.33 L142.83 108.83 L139.83 114.33 L139.00 115.33 L138.17 117.00 L137.33 120.33 L137.17 124.17 L137.00 124.33 L137.00 132.17 L136.83 132.33 L136.83 149.00 L136.67 149.17 L136.33 161.67 L136.17 161.83 L136.17 175.83 L136.00 176.00 L136.17 195.33 L137.00 202.50 L138.00 205.83 L139.00 212.17 L140.00 214.67 L141.00 219.50 L141.83 221.17 L143.00 225.33 L143.83 226.67 L145.00 230.17 L146.17 232.17 L147.00 234.50 L147.83 235.67 L149.17 238.67 L149.83 239.50 L151.00 242.00 L152.00 243.33 L152.83 245.17 L154.00 246.67 L154.83 248.33 L155.83 249.50 L157.17 251.83 L158.00 252.67 L159.00 254.33 L160.00 255.33 L163.00 259.50 L167.83 265.00 L173.00 270.17 L180.00 276.00 L181.50 277.00 L184.67 279.83 L191.17 284.33 L192.00 284.67 L193.50 285.83 L195.83 287.00 L196.50 287.67 L198.83 288.83 L204.33 292.33 L205.33 292.67 L206.67 293.67 L209.50 294.83 L211.00 295.83 L213.33 296.67 L215.00 297.67 L218.50 298.83 L220.33 299.83 L223.67 300.83 L225.50 301.83 L229.67 303.00 L231.17 303.83 L232.83 304.17 L234.00 304.67 L234.67 304.67 L237.33 305.83 L241.67 306.83 L243.33 307.67 L249.00 308.83 L250.83 309.67 L257.00 311.00 L259.17 311.83 L260.50 312.00 L261.67 311.83 L262.17 311.33 L262.00 292.33 L261.83 292.17 L261.67 288.17 L260.33 285.33 L258.83 284.00 L257.17 283.00 L253.00 282.00 L251.00 281.00 L246.83 279.83 L245.50 279.00 L242.17 278.00 L240.50 277.00 L238.00 276.17 L236.00 275.00 L233.67 274.17 L232.17 273.17 L229.00 271.83 L228.17 271.17 L225.50 270.00 L224.17 269.00 L222.00 268.00 L220.67 267.00 L219.17 266.33 L217.33 265.00 L215.33 264.00 L211.50 261.17 L209.50 260.00 L201.83 254.00 L197.17 250.00 L188.67 241.50 L181.17 231.67 L178.50 227.67 L178.17 226.83 L177.00 225.33 L175.83 223.00 L175.00 222.00 L172.67 217.17 L171.83 214.67 L170.83 213.00 L169.83 209.50 L169.00 208.17 L167.83 203.50 L166.83 201.17 L166.33 198.00 L166.00 197.17 L165.83 195.00 L164.83 191.67 L164.50 184.50 L164.33 184.33 L164.33 176.67 L164.00 174.17 L164.00 162.00 L163.83 161.83 L163.83 157.83 L163.67 157.67 L163.67 153.50 L163.00 149.00 L162.67 131.33 L162.00 130.67 L156.00 130.83 L155.00 131.17 L154.67 131.83 L154.83 136.33 L155.00 136.50 L155.00 142.33 L155.33 144.33 L155.50 150.67 L155.83 153.33 L156.00 165.00 L156.17 165.17 L156.17 177.83 L156.67 180.83 L157.00 190.50 L158.00 194.67 L158.17 197.17 L158.83 199.83 L159.00 201.67 L160.00 204.33 L161.00 208.83 L161.83 210.50 L163.00 214.50 L164.00 216.33 L165.00 219.33 L169.00 227.33 L170.00 228.67 L173.00 233.83 L176.83 239.33 L184.83 249.00 L187.50 251.67 L193.67 257.00 L194.67 258.17 L201.83 264.00 L203.33 264.83 L204.67 266.00 L213.17 271.67 L215.50 272.83 L216.50 273.67 L219.17 275.00 L220.50 276.00 L222.67 277.00 L223.50 277.67 L226.50 279.00 L227.33 279.67 L229.83 280.67 L231.67 281.83 L234.00 282.67 L236.00 283.83 L239.33 285.00 L241.50 286.17 L243.83 286.83 L245.17 287.67 L249.50 288.83 L251.17 289.67 L253.17 290.17 L253.83 291.17 L254.00 292.67 L254.00 296.67 L254.17 296.83 L254.17 301.17 L253.50 302.00 L252.33 302.00 L250.00 301.00 L245.00 300.00 L242.67 299.00 L238.17 298.00 L236.50 297.17 L232.33 296.00 L230.83 295.17 L227.00 294.00 L225.17 293.00 L221.50 291.83 L220.17 291.00 L217.33 290.00 L215.83 289.00 L213.00 288.00 L211.83 287.17 L208.67 285.67 L208.17 285.17 L205.50 284.00 L204.50 283.17 L202.67 282.33 L200.50 280.83 L198.83 280.00 L197.33 278.83 L195.67 278.00 L194.50 277.00 L189.67 273.83 L184.50 269.83 L181.33 267.00 L174.67 260.33 L166.83 251.67 L163.00 246.50 L160.67 243.00 L159.67 241.00 L158.83 240.00 L157.67 237.50 L156.67 236.17 L155.67 233.83 L154.83 232.67 L153.67 229.67 L152.83 228.50 L151.83 225.50 L150.83 223.83 L149.67 219.83 L149.00 218.67 L147.83 214.50 L147.83 213.83 L146.67 210.83 L145.83 205.83 L144.83 202.83 L144.00 196.50 L143.67 190.50 L143.33 188.67 L143.17 184.50 L143.83 177.83 L144.17 155.67 L144.50 153.17 L144.67 133.50 L144.83 133.33 L145.00 127.67 L145.67 123.33 L145.67 120.50 L146.00 119.17 L147.00 117.17 L147.83 116.17 L148.83 114.17 L149.67 113.17 L150.83 110.83 L151.83 109.50 L152.83 107.33 L153.67 106.33 L155.17 103.33 L156.17 102.00 L157.00 100.17 L157.83 99.17 L160.83 93.50 L161.67 92.50 L162.83 90.17 L165.83 85.50 L167.67 82.00 L168.17 79.17 L168.17 77.17 L168.67 72.83 L168.67 70.00 L169.67 65.00 L169.83 60.33 L170.17 58.50 L171.00 58.00 L183.33 58.00 L183.50 58.17 L187.33 58.33 L188.17 58.00 L188.50 57.33 L188.50 28.50 L188.17 28.00 L187.33 27.67 L167.50 28.00 L167.33 27.83 L164.17 27.83 L160.17 27.00 L137.83 27.00Z"/><path fill="#FF7B00" fill-rule="evenodd" d="M188.83 88.00 L188.83 90.67 L189.67 92.33 L190.83 93.33 L192.33 94.17 L194.67 94.17 L194.83 94.33 L333.17 94.33 L334.00 94.50 L335.50 94.17 L337.33 94.33 L338.17 94.00 L339.83 92.50 L340.83 91.00 L340.67 87.00 L339.33 85.00 L337.50 84.00 L194.67 84.00 L193.00 84.83 L191.33 85.17 L189.17 87.17Z M173.67 65.17 L173.00 66.17 L173.00 181.00 L173.17 181.17 L173.00 184.00 L174.00 185.67 L174.17 188.50 L175.00 190.50 L175.33 192.50 L175.83 193.33 L176.00 195.17 L176.83 196.83 L177.00 198.50 L178.50 201.67 L179.00 204.00 L180.83 207.67 L181.17 209.50 L182.17 210.50 L183.17 212.33 L183.67 212.83 L184.50 215.00 L185.67 216.50 L187.17 219.50 L188.67 221.67 L189.17 223.17 L191.83 226.33 L192.33 227.50 L199.83 235.50 L207.00 242.33 L215.33 248.67 L219.67 251.67 L220.83 252.17 L223.00 253.83 L225.50 255.00 L226.50 255.83 L227.50 256.00 L231.83 258.17 L233.33 259.50 L234.50 260.00 L235.33 260.67 L236.83 261.00 L240.50 262.83 L241.17 263.50 L241.83 263.83 L242.50 263.83 L246.17 265.83 L248.33 266.67 L249.00 266.67 L250.67 267.67 L251.83 267.83 L253.67 268.83 L255.00 269.00 L255.67 269.50 L257.50 270.00 L258.67 270.67 L260.17 271.00 L260.83 271.50 L263.33 272.17 L266.83 271.83 L268.83 270.67 L269.50 270.67 L271.67 270.00 L274.33 268.83 L275.67 268.67 L277.17 267.83 L278.00 267.83 L279.67 266.83 L282.83 266.00 L284.50 265.00 L286.83 264.50 L290.00 262.67 L291.83 261.83 L292.83 261.67 L295.83 260.00 L297.50 259.50 L298.83 258.33 L300.33 257.67 L302.50 256.00 L304.17 255.50 L307.50 253.00 L311.33 250.83 L323.33 241.83 L331.33 234.17 L335.00 230.33 L340.33 223.67 L340.83 222.50 L341.83 221.33 L343.33 218.83 L345.67 216.50 L346.17 215.50 L347.67 213.67 L348.67 211.67 L348.83 210.83 L349.67 209.50 L350.00 208.00 L350.67 206.67 L351.67 205.50 L352.00 202.83 L352.67 201.67 L353.00 200.00 L353.83 198.50 L354.00 196.67 L354.83 194.00 L354.83 193.17 L355.67 191.50 L355.83 190.67 L356.00 186.67 L356.83 184.50 L356.83 65.83 L356.67 65.50 L356.00 65.00 L174.17 65.00Z M199.83 221.33 L200.00 220.17 L200.83 219.67 L258.83 219.67 L259.33 219.83 L260.00 220.67 L260.00 244.33 L261.00 246.17 L262.50 247.67 L263.67 248.00 L266.50 248.00 L268.17 247.17 L269.83 245.50 L270.17 244.50 L270.17 222.00 L270.00 220.83 L270.83 219.83 L271.50 219.67 L331.67 219.67 L332.67 220.33 L332.67 220.83 L331.17 222.33 L330.67 223.50 L329.00 224.83 L325.00 229.50 L321.50 233.00 L315.17 238.33 L306.50 244.67 L305.17 245.17 L304.17 246.00 L302.33 246.83 L297.67 249.83 L295.83 250.50 L294.00 251.83 L291.83 252.83 L290.33 253.17 L288.83 254.17 L286.67 254.83 L285.00 255.83 L283.50 256.00 L282.17 256.83 L280.33 257.17 L279.33 258.00 L277.83 258.67 L275.33 259.17 L272.33 260.67 L269.50 261.17 L268.33 262.00 L264.67 263.17 L262.50 263.00 L260.50 262.17 L259.33 262.00 L258.00 261.17 L256.67 260.83 L255.50 260.17 L253.83 259.83 L253.00 259.17 L250.17 258.17 L248.67 257.17 L247.33 257.00 L245.83 256.17 L244.50 255.83 L239.33 253.00 L238.83 253.00 L231.83 249.17 L230.67 248.83 L228.50 247.67 L225.67 245.33 L224.00 244.67 L222.67 243.33 L221.67 242.83 L220.00 241.33 L218.33 240.33 L217.17 239.17 L216.00 238.67 L214.33 237.00 L212.67 236.00 L203.83 227.17Z M198.83 185.83 L199.50 185.17 L200.17 185.17 L200.83 185.50 L206.17 185.50 L206.33 185.33 L210.00 185.33 L210.17 185.50 L321.17 185.50 L321.33 185.33 L324.33 185.33 L324.50 185.50 L326.83 185.50 L327.00 185.33 L330.83 185.50 L331.50 186.17 L331.50 187.00 L330.00 189.33 L327.67 191.50 L324.00 192.83 L322.67 192.67 L208.33 192.67 L207.17 192.83 L204.00 192.00 L201.83 190.50 L200.17 188.83 L199.50 187.17 L198.83 186.50Z M199.67 173.17 L200.67 172.00 L201.67 171.50 L203.33 170.17 L206.00 169.67 L207.00 169.17 L208.50 168.83 L322.17 168.83 L323.17 169.00 L326.67 170.33 L329.50 172.50 L330.17 173.33 L330.17 173.83 L329.33 174.67 L327.67 174.50 L327.50 174.67 L200.50 174.67 L199.67 174.00Z M222.67 111.17 L223.67 110.17 L306.17 110.17 L307.00 110.83 L307.17 112.33 L306.83 114.50 L304.83 118.67 L303.33 120.83 L301.67 122.33 L300.83 122.67 L229.50 122.67 L227.50 121.83 L224.33 117.83 L223.83 116.67 L223.67 114.83 L222.67 113.00Z M182.17 76.50 L182.67 76.00 L183.67 75.67 L347.00 75.67 L347.67 76.00 L348.00 76.50 L348.00 185.33 L347.17 187.17 L346.83 191.50 L346.17 193.33 L346.00 195.17 L345.00 196.83 L344.83 198.33 L344.17 199.33 L343.83 200.83 L343.00 202.00 L342.67 203.33 L341.17 205.33 L340.50 206.83 L339.17 208.00 L271.33 208.00 L270.33 207.33 L270.00 206.33 L270.00 205.33 L270.33 204.33 L271.00 203.83 L271.83 203.67 L323.83 203.67 L326.00 202.83 L327.83 202.50 L333.50 199.67 L336.00 197.83 L337.50 196.33 L339.67 193.50 L340.00 192.50 L340.67 191.67 L341.00 190.17 L341.67 189.17 L342.00 187.67 L342.67 186.17 L342.83 181.33 L343.00 181.17 L342.83 178.83 L343.67 177.33 L343.67 176.50 L342.83 175.33 L341.83 172.33 L340.33 169.33 L337.00 164.83 L336.00 163.83 L333.67 162.33 L332.33 161.00 L330.00 159.83 L327.67 158.17 L327.17 158.00 L271.33 158.00 L270.17 156.83 L270.17 154.67 L270.00 154.50 L270.33 153.33 L271.33 152.67 L275.83 152.67 L276.00 152.83 L277.67 152.67 L321.50 152.67 L321.67 152.83 L328.33 152.67 L329.67 152.00 L331.50 151.50 L334.33 149.33 L338.00 145.33 L339.67 142.83 L340.67 140.67 L340.83 139.50 L341.83 138.00 L342.67 135.33 L342.83 133.67 L343.67 131.33 L343.83 129.67 L343.67 125.83 L343.00 124.67 L342.17 123.83 L339.83 122.83 L336.17 123.00 L335.50 123.33 L334.50 124.33 L333.50 126.50 L333.00 132.67 L332.17 134.50 L332.00 135.50 L330.50 138.50 L328.00 141.17 L326.33 142.00 L271.17 142.00 L270.17 141.00 L270.17 134.67 L270.50 134.00 L271.33 133.33 L301.83 133.33 L304.00 132.83 L305.00 132.33 L308.17 130.17 L310.17 128.33 L313.50 124.17 L314.83 121.17 L315.67 120.00 L316.00 118.00 L316.83 116.17 L316.83 115.00 L317.50 113.17 L317.67 111.50 L318.33 110.67 L319.50 110.17 L336.50 110.17 L337.67 109.83 L339.33 108.67 L340.50 107.50 L340.83 106.67 L340.83 103.33 L340.17 102.17 L338.50 100.83 L337.33 99.50 L336.67 99.17 L194.17 99.17 L191.83 100.33 L190.50 101.33 L189.33 102.83 L188.83 104.00 L188.83 106.17 L189.33 107.50 L190.50 108.50 L192.50 109.67 L194.83 110.17 L209.67 110.17 L210.00 110.00 L211.17 110.33 L212.17 111.50 L213.00 114.33 L213.00 117.00 L215.33 122.50 L218.67 127.50 L223.50 131.67 L225.50 132.67 L228.67 133.50 L230.50 133.50 L230.67 133.33 L258.83 133.33 L259.83 134.17 L260.00 134.67 L260.00 141.00 L259.17 142.00 L204.00 142.00 L203.17 141.67 L200.67 139.33 L198.00 135.17 L197.67 133.83 L197.00 132.67 L196.83 127.00 L195.83 124.50 L194.67 123.33 L193.50 122.83 L192.50 122.67 L189.33 122.83 L188.67 123.00 L187.33 124.17 L186.00 127.17 L186.00 129.00 L186.17 129.17 L186.00 130.83 L186.83 133.17 L186.83 135.67 L187.17 137.17 L189.33 141.67 L192.33 146.17 L194.00 148.00 L197.67 150.83 L199.17 151.67 L200.50 152.00 L201.83 152.67 L218.00 152.67 L218.17 152.83 L258.83 152.67 L259.33 152.83 L260.00 153.67 L260.00 156.83 L259.83 157.33 L259.00 158.00 L203.33 158.00 L202.83 158.17 L200.50 159.83 L197.83 161.33 L194.33 164.17 L192.33 166.17 L191.50 167.67 L190.17 169.17 L188.17 173.17 L187.83 174.83 L187.33 175.83 L187.33 179.00 L187.50 179.17 L187.33 182.83 L188.00 188.83 L189.33 192.17 L192.33 196.33 L196.33 199.67 L200.17 201.83 L202.33 202.67 L204.67 203.00 L206.33 203.67 L258.67 203.67 L259.50 204.00 L260.00 204.83 L260.00 207.17 L259.67 207.67 L259.00 208.00 L190.67 208.00 L189.00 206.50 L188.00 205.00 L187.67 203.50 L186.83 202.17 L186.83 201.67 L186.00 200.17 L185.67 198.83 L184.83 197.33 L184.67 196.17 L183.83 194.50 L183.67 191.83 L182.83 190.33 L182.67 188.50 L182.00 186.50 L182.00 178.83 L182.17 178.67 L182.00 177.33 L182.00 138.50 L182.17 138.33 L182.00 136.83 L182.00 122.33 L182.17 122.17 L182.17 119.67 L182.00 119.50 L182.00 117.83 L182.17 117.67 L182.17 114.83 L182.00 114.67 L182.00 108.17 L182.17 108.00 L182.17 105.67 L182.00 105.50 L182.00 88.33 L182.17 88.17 L182.00 77.00Z"/></svg>`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">`;

const CSS = `
    :root {
      --orange:${C.orange}; --ember:${C.ember}; --charcoal:${C.charcoal}; --ink:${C.ink};
      --stone:${C.stone}; --travertine:${C.travertine}; --marble:${C.marble};
      --good:${C.good}; --bad:${C.bad};
      --serif:"Cormorant Garamond", "Noto Serif SC", Georgia, "Times New Roman", serif;
      --sans:Montserrat, "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      /* older names, still used by scripts written before the rebrand */
      --navy:${C.charcoal}; --gold:${C.ember}; --light:${C.marble};
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body { margin: 0; background: var(--marble); color: var(--charcoal); font-family: var(--sans); font-size: 15px; line-height: 1.55; }
    a { color: var(--ember); }
    .tez-top { background: var(--charcoal); color: var(--marble); }
    .tez-bar { max-width: 1120px; margin: 0 auto; padding: 14px 20px 0; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .tez-shield { height: 40px; width: auto; display: block; flex: 0 0 auto; }
    .tez-title { font-family: var(--serif); font-weight: 600; font-size: 24px; line-height: 1.1; letter-spacing: .2px; }
    .tez-title small { display: block; font-family: var(--sans); font-weight: 600; font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: var(--travertine); opacity: .8; margin-bottom: 3px; }
    .tez-who { margin-left: auto; font-size: 12px; color: var(--travertine); display: flex; align-items: center; gap: 12px; }
    .tez-who strong { color: #fff; font-weight: 600; }
    .tez-who form { margin: 0; }
    .tez-signout { background: none; border: 1px solid rgba(232,227,220,.35); color: var(--marble); font: 600 11px var(--sans); letter-spacing: .08em; text-transform: uppercase; padding: 7px 12px; border-radius: 3px; cursor: pointer; }
    .tez-signout:hover { border-color: var(--orange); }
    .tez-nav { max-width: 1120px; margin: 0 auto; padding: 10px 20px 0; display: flex; gap: 4px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .tez-nav a { flex: 0 0 auto; color: var(--travertine); text-decoration: none; font-size: 12px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; padding: 11px 14px 12px; border-bottom: 3px solid transparent; white-space: nowrap; }
    .tez-nav a:hover { color: #fff; }
    .tez-nav a[aria-current="page"] { color: #fff; border-bottom-color: var(--orange); }
    .tez-nav .n { display: inline-block; min-width: 18px; padding: 1px 5px; margin-left: 6px; border-radius: 9px; background: var(--orange); color: var(--ink); font-size: 10px; letter-spacing: 0; text-align: center; }
    main { max-width: 1120px; margin: 28px auto 60px; padding: 0 20px; }
    .page-header { margin-bottom: 22px; }
    .page-header h1 { font-family: var(--serif); font-weight: 600; font-size: 38px; line-height: 1.1; margin: 0 0 8px; color: var(--charcoal); text-wrap: balance; }
    .page-header .sub { font-size: 14px; color: var(--stone); max-width: 68ch; }
    .page-header .back { font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; text-decoration: none; }
    h2, h3 { font-family: var(--serif); font-weight: 600; color: var(--charcoal); }
    h3 { font-size: 22px; margin: 0 0 10px; }
    .card { background: #fff; border: 1px solid var(--travertine); border-radius: 4px; padding: 22px; margin-bottom: 16px; }
    .card.flush { padding: 0; overflow: hidden; }
    .card.note { border-left: 3px solid var(--orange); }
    .card.ok { border-left: 3px solid var(--good); }
    .card.warn { border-left: 3px solid var(--bad); }
    .btn-primary, .btn-secondary { display: inline-block; font: 600 12px var(--sans); letter-spacing: .1em; text-transform: uppercase; text-decoration: none; padding: 12px 20px; border-radius: 3px; cursor: pointer; line-height: 1.2; }
    .btn-primary { background: var(--charcoal); color: var(--marble); border: 1px solid var(--charcoal); }
    .btn-primary:hover { background: var(--ink); box-shadow: inset 0 -3px 0 var(--orange); }
    .btn-primary:disabled { opacity: .55; cursor: default; box-shadow: none; }
    .btn-secondary { background: #fff; color: var(--charcoal); border: 1px solid var(--charcoal); }
    .btn-secondary:hover { background: var(--marble); }
    .btn-small { padding: 8px 12px; font-size: 11px; }
    .btn-danger { background: #fff; color: var(--bad); border: 1px solid var(--bad); }
    :focus-visible { outline: 2px solid var(--orange); outline-offset: 2px; }
    label, .label { display: block; font-size: 10.5px; font-weight: 600; color: var(--stone); text-transform: uppercase; letter-spacing: .14em; margin-bottom: 5px; }
    input, textarea, select { width: 100%; padding: 11px 12px; border: 1px solid #CFC8BE; border-radius: 3px; font: 400 15px var(--sans); color: var(--charcoal); background: #fff; }
    input[type="checkbox"], input[type="radio"] { width: 18px; height: 18px; padding: 0; accent-color: var(--charcoal); }
    input:focus, textarea:focus, select:focus { outline: none; border-color: var(--charcoal); box-shadow: 0 0 0 3px rgba(255,123,0,.22); }
    .hint { font-size: 12px; color: var(--stone); margin-top: 5px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .field { margin-bottom: 16px; }
    .status-badge, .tag { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--charcoal); white-space: nowrap; }
    .status-badge::before, .tag::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--dot, var(--stone)); flex: 0 0 auto; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 22px; }
    .tile { background: #fff; border: 1px solid var(--travertine); border-top: 3px solid var(--travertine); border-radius: 4px; padding: 14px 16px; }
    .tile.hot { border-top-color: var(--orange); }
    .tile .k { font-size: 10.5px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--stone); }
    .tile .v { font-family: var(--serif); font-weight: 700; font-size: 38px; line-height: 1.05; font-variant-numeric: lining-nums; }
    .rows > a, .rows > div { display: grid; grid-template-columns: minmax(0, 1fr) 190px 120px; gap: 6px 18px; align-items: start; padding: 16px 22px; border-top: 1px solid var(--travertine); text-decoration: none; color: inherit; }
    .rows > :first-child { border-top: 0; }
    .rows > a:hover { background: var(--marble); }
    .rows .t { font-weight: 600; color: var(--charcoal); overflow-wrap: anywhere; }
    .rows .m { font-size: 12.5px; color: var(--stone); margin-top: 2px; }
    .empty { padding: 44px 22px; text-align: center; color: var(--stone); }
    .timeline > div { display: grid; grid-template-columns: 12px minmax(0, 1fr); gap: 14px; padding: 12px 0; border-top: 1px solid var(--travertine); }
    .timeline > div:first-child { border-top: 0; }
    .timeline .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--travertine); margin-top: 7px; }
    .timeline .dot.on { background: var(--orange); }
    .timeline .what { font-size: 14px; }
    .timeline .when { font-size: 12px; color: var(--stone); margin-top: 2px; }
    .quote { background: var(--marble); border-left: 2px solid var(--travertine); padding: 10px 12px; margin-top: 8px; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .bar { background: var(--travertine); border-radius: 2px; height: 6px; overflow: hidden; margin-bottom: 16px; }
    .bar > i { display: block; height: 100%; background: var(--charcoal); }
    .foot { max-width: 1120px; margin: 0 auto; padding: 0 20px 36px; font-size: 12px; color: var(--stone); }
    @media (max-width: 720px) {
      .tez-bar { padding: 12px 14px 0; }
      .tez-title { font-size: 20px; }
      .tez-who { width: 100%; margin-left: 0; justify-content: space-between; }
      .tez-nav { padding: 6px 6px 0; }
      main { margin-top: 20px; padding: 0 14px; }
      .page-header h1 { font-size: 30px; }
      .card { padding: 16px; }
      .grid2 { grid-template-columns: 1fr; gap: 0; }
      .grid2 > div { margin-bottom: 16px; }
      .rows > a, .rows > div { grid-template-columns: 1fr; padding: 14px 16px; }
    }
    @media (prefers-reduced-motion: no-preference) { .btn-primary, .tez-nav a { transition: box-shadow .12s ease, color .12s ease, border-color .12s ease; } }
`;

/**
 * A whole page.
 * @param {string} o.title     browser tab
 * @param {string} o.area      the words beside the shield ("Consultant Portal")
 * @param {Array}  o.nav       [{ key, href, label, count }]
 * @param {string} o.active    key of the current nav item
 * @param {string} o.who       display name of the signed-in person
 * @param {string} o.body      inner HTML (already escaped by the caller)
 * @param {string} [o.signOut] POST target for the sign-out button
 */
function page({ title, area, nav = [], active = null, who = "", body = "", signOut = "/logout", foot = "" }) {
  const links = nav.map(n =>
    `<a href="${esc(n.href)}"${n.key === active ? ' aria-current="page"' : ""}>${esc(n.label)}${n.count ? `<span class="n">${esc(n.count)}</span>` : ""}</a>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — TEZ Law Firm</title>
  ${FONTS}
  <style>${CSS}</style>
</head>
<body>
  <header class="tez-top">
    <div class="tez-bar">
      ${SHIELD}
      <div class="tez-title"><small>TEZ Law Firm</small>${esc(area)}</div>
      <div class="tez-who">
        <span>Signed in as <strong>${esc(who)}</strong></span>
        <form method="POST" action="${esc(signOut)}"><button type="submit" class="tez-signout">Sign out</button></form>
      </div>
    </div>
    ${links ? `<nav class="tez-nav" aria-label="Sections">${links}</nav>` : `<div style="height:14px;"></div>`}
  </header>
  <main>${body}</main>
  ${foot ? `<div class="foot">${foot}</div>` : ""}
</body>
</html>`;
}

module.exports = { C, CSS, FONTS, SHIELD, esc, page };
