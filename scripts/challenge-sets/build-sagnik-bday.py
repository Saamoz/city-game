# Builds sagnik-bday.json, the Sagnik birthday Challenge Hunt set. Load it with import.mjs.
import json, os
def bonus(i, label): return {"id": f"b{i}", "label": label, "points": 1}
def rect(w,s,e,n): return {"type":"Polygon","coordinates":[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}
def anywhere(hint=None): return {"placement":"anywhere", **({"hint":hint} if hint else {})}
def pin(lng,lat,r): return {"placement":"pin","point":[lng,lat],"radiusMeters":r}
def area(poly): return {"placement":"area","area":poly}
items = [
 dict(title="Costco rotisserie chicken", short="Get a Costco rotisserie chicken.", where=anywhere("Any Costco"),
      bonuses=["Eat the whole chicken","Elevate it and offer it to Sagnik"]),
 dict(title="Trader Joe's snack review", short="Review one Trader Joe's snack per team member, with at least 30 seconds of commentary each.", where=anywhere("Any Trader Joe's")),
 dict(title="Bike test ride", short="Test ride a bike at any shop where you can buy a bike.", where=anywhere("Any bike shop")),
 dict(title="REI fashion show", short="3+ teammates each try on a base layer, a shell and hiking pants or shorts. Take runway shots.",
      long="At least 3 team members must each put on (1) a base layer, (2) a shell or outer layer and (3) hiking pants or shorts, then strut it for runway shots.",
      where=pin(-87.6509,41.9087,90), bonuses=["Add a backpack and shoes"]),
 dict(title="Build a box", short="Build a box from scratch out of any material, big enough to hold a set of keys.", where=anywhere()),
 dict(title="Not in English", short="Complete a full transaction in a language that isn't English.", where=anywhere(), bonuses=["In Hindi or Bangla"]),
 dict(title="Ethiopian food", short="Order something from an Ethiopian restaurant and taste it.", where=anywhere("Any Ethiopian restaurant"), bonuses=["Offer it to Sagnik"]),
 dict(title="Jeni's taste test", short="Taste test at Jeni's and film a 1-minute review video.", where=anywhere("Any Jeni's"), bonuses=["Everyone finishes at least one scoop"]),
 dict(title="Hamilton monument", short="Perform 1 minute of a Hamilton song at the Alexander Hamilton statue.", where=pin(-87.63844,41.93171,60), bonuses=["The full song (3+ minutes)"]),
 dict(title="Broadway Playbill", short="Get a Broadway Playbill.", where=anywhere("Any theatre")),
 dict(title="The 606", short="Cover at least 1 mile on the 606 and log it on Strava.", where=area(rect(-87.7232,41.9130,-87.6650,41.9157)), bonuses=["Do the whole trail"]),
 dict(title="Lakefront statue", short="Find a sculpture or monument along the Lakefront Trail and imitate it.", where=anywhere("Along the Lakefront Trail")),
 dict(title="Knee-deep", short="The full team stands knee-deep in any lake, beach or pool.", where=anywhere("Any water"), bonuses=["At least 2 people fully submerged"]),
 dict(title="How long is your wood?", short="At any Home Depot, estimate a plank's length to within 2 inches, on video. Use the terminology.", where=anywhere("Any Home Depot")),
 dict(title="Piggyback poet", short="In a wooded park, carry a teammate 30+ seconds while waxing poetic about the nature around you.", where=anywhere("Any wooded park"), bonuses=["Keep it up for 75+ seconds"]),
 dict(title="Colour hunt", short="Make a 3×3 photo grid of purple, violet or lavender things.", where=anywhere(), bonuses=["One of the photos is a birthday cake"]),
 dict(title="Flag of India", short="Find a flag of India.", where=anywhere()),
 dict(title="Go Bears", short="Catch the Cal vs SMU game, say \"Go Bears\" and get someone else to say it back.", where=anywhere("Wherever the game's on")),
 dict(title="Metra balloon", short="Ride the Metra with a balloon for at least one stop.", where=anywhere("On the Metra"), bonuses=["It's a Happy Birthday balloon and you offer it to Sagnik"]),
 dict(title="Strava art", short="Make Strava art spelling any word of at least 4 letters.", where=anywhere()),
 dict(title="Plane spotting", short="Photograph and correctly identify 3+ aircraft. No AI image search, but research is fine.", where=anywhere()),
 dict(title="La Fournette", short="Get a baked good at La Fournette.", where=pin(-87.6345,41.9096,50), bonuses=["Offer it to Sagnik"]),
 dict(title="Boystown bar", short="At a bar in Boystown, strike up a conversation with a stranger (not the bartender).", where=area(rect(-87.6532,41.9385,-87.6428,41.9508)), bonuses=["You get their number"]),
 dict(title="Silent disco", short="Put music in your earbuds and dance like nobody's watching in front of Soundbar.", where=pin(-87.6347,41.8932,60)),
 dict(title="Bird spotting", short="Identify at least 3 birds at the Montrose Point Bird Sanctuary.", where=pin(-87.635177,41.962726,180), bonuses=["Identify 6 or more"]),
 dict(title="Library quote", short="At the Chinatown library, find a John Green book and a quote on the human condition.",
      long="Find one of John Green's books at the Chinatown branch of the Chicago Public Library, then find a quote in it that comments on the human condition.",
      where=pin(-87.6323,41.8543,70)),
 dict(title="Northerly Island landing", short="One person is the plane, another is air traffic control. Land on the old Meigs Field airstrip.", where=area(rect(-87.6115,41.8548,-87.6030,41.8656))),
]
for i in items:
    assert len(i["title"])<=38, i["title"]
    assert len(i["short"])<=96, (len(i["short"]), i["short"])
out={"setName":"Sagnik","items":[{
  "title":i["title"],"shortDescription":i["short"],**({"longDescription":i["long"]} if "long" in i else {}),
  "points":1,"where":i["where"],"bonuses":[bonus(n+1,b) for n,b in enumerate(i.get("bonuses",[]))]} for i in items]}
json.dump(out,open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"sagnik-bday.json"),"w"),indent=2,ensure_ascii=False)
print(len(items))
