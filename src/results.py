from .models import SavedQuery
from pudgy.util  import getrandhash
import json

def save_for_user(user, params, results):
    table = params.get('table')

    params = params.__json__()
    hashid = getrandhash(json.dumps(params))
    hashid = hashid[:10]
    sq = SavedQuery.create(results=results, user=user.id, parsed=params, hashid=hashid, table=table)

    return sq

def get_for_user(user, table, limit=30):
    res = SavedQuery \
        .select().limit(limit) \
        .order_by(-SavedQuery.created) \
        .where(SavedQuery.user == user.id and SavedQuery.table == table).dicts()

    return list(reversed(res))

def get_by_hashid(hashid):
    return list(SavedQuery.select().where(SavedQuery.hashid == hashid).dicts())
