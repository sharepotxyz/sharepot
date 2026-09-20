#!/usr/bin/env python3
"""Restores full-width punctuation in CJK dictionaries (some editors write , : ( ) as ASCII): a mark next to CJK text
becomes its full-width form; tags, {slots} and digits like 09:30 are left alone. Run until it reports 0 changes.
Usage: i18n-fullwidth.py web/src/i18n/zh-TW.json web/src/i18n/docs.zh-TW.json ..."""
import json,re,sys,collections
CJK=re.compile('[぀-ヿ㐀-鿿、。「」『』＀-￯—…]')
MAP={',':'，',';':'；',':':'：','?':'？','!':'！'}
def conv(s):
    toks=[]
    def stash(m): toks.append(m.group(0)); return chr(0xe000+len(toks)-1)
    p=re.sub(r'<[^>]+>|\{\w+\}',stash,s)
    ch=list(p); n=len(ch)
    skip=lambda c: c==' ' or ''<=c<=''
    def nb(i,step):
        j=i+step
        while 0<=j<n and skip(ch[j]): j+=step
        return ch[j] if 0<=j<n else ''
    # parentheses, as pairs
    stack=[]
    for i,c in enumerate(ch):
        if c=='(' : stack.append(i)
        elif c==')' and stack:
            a=stack.pop(); inner=''.join(ch[a+1:i])
            if CJK.search(inner) or CJK.match(nb(a,-1) or ' ') or CJK.match(nb(i,1) or ' '):
                ch[a]='（'; ch[i]='）'
    for i,c in enumerate(ch):
        if c in MAP:
            l,r=nb(i,-1),nb(i,1)
            if c in ',:' and (ch[i-1:i] or [''])[0].isdigit() and (ch[i+1:i+2] or [''])[0].isdigit(): continue
            if (l and CJK.match(l)) or (r and CJK.match(r)): ch[i]=MAP[c]
    out=''.join(ch)
    # a full-width mark carries its own spacing
    out=re.sub('([，；：？！）]) (?=[^ ])',r'\1',out)
    out=re.sub(' (（)',r'\1',out)
    return re.sub('[-]',lambda m:toks[ord(m.group(0))-0xe000],out)
for f in sys.argv[1:]:
    d=json.load(open(f,encoding='utf-8'),object_pairs_hook=collections.OrderedDict); k=0
    for key,v in d.items():
        lead=len(v)-len(v.lstrip(' ')); nv=conv(v)
        if nv!=v: d[key]=nv; k+=1
    json.dump(d,open(f,'w',encoding='utf-8'),ensure_ascii=False,indent=2); open(f,'a').write('\n')
    print(f,k,'strings changed')
